// Employee account registration (team-agreed flow, 2026-11-16; master prompt §IV).
//   1. HR encodes the new hire and generates the Employee ID (JV-YYYY-NNNNN) and the Employee Unique Code. JVzPay reads
//      HR's records by pull (hrSyncService.js); HR sends no events.
//   2. The new hire registers here with name, Employee ID, department, position, unique code and the onboarding email,
//      and chooses a password. HR checks them (POST {HR}/employees/verify); only match + eligible registers. When HR
//      cannot be reached the registration is refused: there is no offline registration.
//   3. The account is activated at once. Payroll/Accounting staff sign in to JVzPay with the role of their position;
//      CRM and Inventory sign their staff in through JVzPay's department login (below). Every employee keeps
//      Self-Service (payslips, leave, attendance, approvals) in JVzPay.
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { select, selectOne, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { checkPassword } from "../lib/validate.js";
import { badRequest } from "../lib/errors.js";
import { getSetting } from "../lib/settings.js";
import { targetConfig, enqueue, callApp } from "./integrationService.js";
import { mismatchLabels } from "./hrMapping.js";
import { syncOneEmployee, HrUnavailableError } from "./hrSyncService.js";
import { roleForPosition, accountingDepartment } from "../lib/orgSettings.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NO_MATCH = "These details do not match HR's records. Check them with HR: Employee ID, unique code, name, email, department and position must all be exactly as HR encoded them.";
const NOT_ELIGIBLE = "Your details match HR's records, but you cannot register yet: HR must first approve your onboarding, and your status must be Active or On Leave. Please finish your onboarding and contact HR.";

// the JVzPay department; its people get a working role in JVzPay from their position (POSITION_ROLES, lib/orgSettings.js)
export { roleForPosition };

export function checkForm(body) {
  const v = {
    employee_no: String(body.employee_no || "").trim().toUpperCase(),
    verification_code: String(body.verification_code || "").trim(),
    full_name: String(body.full_name || "").trim().replace(/\s+/g, " "),
    email: String(body.email || "").trim().toLowerCase(),
    department_id: String(body.department_id || "").trim(),
    position_title: String(body.position_title || "").trim(),
  };
  const password = String(body.password || ""), confirm = String(body.confirm_password || "");
  const errors = {};
  // HR's formats: Employee ID JV-<year hired>-<5-digit number> (JV-2026-00004); unique code LASTNAME + hire date MMDDYYYY
  if (!/^JV-\d{4}-\d{5}$/.test(v.employee_no)) errors.employee_no = "Enter your Employee ID exactly as HR gave it, for example JV-2026-00004.";
  if (!v.verification_code || v.verification_code.length > 64) errors.verification_code = "Enter the unique code HR gave you (your last name and hire date, for example BAUTISTA11172026).";
  if (!v.full_name || v.full_name.length > 160) errors.full_name = "Enter your full name as HR has it.";
  if (!EMAIL.test(v.email) || v.email.length > 190) errors.email = "Enter the email address you gave HR.";
  if (!/^\d+$/.test(v.department_id)) errors.department_id = "Choose your department.";
  if (!v.position_title) errors.position_title = "Choose your position.";
  const problem = checkPassword(password, v.email);
  if (problem) errors.password = problem;
  if (password !== confirm) errors.confirm_password = "Passwords do not match.";
  if (body.privacy_ack !== "1") errors.privacy_ack = "Confirm that you have read the Privacy Notice.";
  return { values: v, password, errors };
}

const HR_DOWN = "The HR system could not be reached, so your details cannot be checked right now. Registration needs HR's confirmation; please try again in a few minutes.";

const localEmployee = (employeeId) => selectOne(
  `SELECT e.*, d.code AS department_code, d.name AS department_name, p.title AS position_title FROM employees e
     JOIN departments d ON d.id = e.department_id JOIN positions p ON p.id = e.position_id
    WHERE (e.employee_no = ? OR e.hr_employee_id = ?) AND e.deleted_at IS NULL AND e.hr_employee_id IS NOT NULL
    ORDER BY e.hr_employee_id = ? DESC LIMIT 1`, [employeeId, employeeId, employeeId]);

/**
 * HR decides (team decision 2026-11-16): POST {HR}/employees/verify → {match, eligible, mismatches, employee}.
 * There is no offline registration: when HR cannot be reached, the registration is refused.
 * Returns { emp, check } on success, or { refused: "mismatch", fields } / { refused: "not_eligible" }.
 */
async function verifyWithHr(v, dept) {
  if (!targetConfig("hr").connected) throw badRequest(HR_DOWN);
  let res, body;
  // HR's format (integration-api-HR.md): exactly these 7 required strings. employee_code is the Employee Unique Code;
  // verification_reference is JVzPay's OWN id for this registration attempt (it appears in HR's audit log and ours).
  const reference = `ESS-REG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  try {
    res = await callApp("hr", "POST", "/employees/verify", {
      employee_id: v.employee_no, full_name: v.full_name, email: v.email, department: dept.name, position: v.position_title,
      employee_code: v.verification_code, verification_reference: reference,
    });
    body = await res.json().catch(() => null);
  } catch {
    throw badRequest(HR_DOWN); // no answer at all
  }
  if (res.status >= 500) throw badRequest(HR_DOWN);
  if (res.status === 404) return { refused: "mismatch", fields: ["Employee ID"], reference };
  // 400: HR could not check the details as sent (its `errors` names the fields) — the details, not HR, are the problem
  if (res.status === 400 || res.status === 422) return { refused: "invalid", fields: mismatchLabels(body?.errors), reference };
  if (!res.ok || !body || typeof body.match !== "boolean") throw badRequest(HR_DOWN);
  if (!body.match) return { refused: "mismatch", fields: mismatchLabels(body.mismatches), reference };
  if (body.eligible !== true) return { refused: "not_eligible", reference };
  // HR confirmed the person. Payroll and the department login need JVzPay's copy of the record: bring it now if the
  // 15-minute sync has not yet.
  const hrId = body.employee?.permanent_employee_id || v.employee_no;
  let emp = (await localEmployee(hrId)) || (await localEmployee(v.employee_no));
  if (!emp) {
    try { await syncOneEmployee(hrId, body.employee || null); } catch (e) { if (e instanceof HrUnavailableError) throw badRequest(HR_DOWN); throw badRequest(`HR confirmed your details, but your HR record could not be loaded: ${e.message}. Please contact HR.`); }
    emp = await localEmployee(hrId);
  }
  if (!emp) throw badRequest("HR confirmed your details, but your HR record could not be loaded yet. Please try again in a few minutes.");
  return { emp, check: "hr_api", reference };
}

export async function register(req, body) {
  const { values: v, password, errors } = checkForm(body);
  if (!errors.email && (await selectOne("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", [v.email])))
    errors.email = "An account with this email already exists. Sign in instead.";
  if (Object.keys(errors).length) return { errors, values: v };
  const dept = await selectOne("SELECT id, code, name FROM departments WHERE id = ?", [v.department_id]);
  if (!dept) return { errors: { department_id: "Choose your department." }, values: v };

  const match = await verifyWithHr(v, dept);
  const ref = ` [${match.reference}]`;
  if (match.refused === "mismatch") {
    await audit(req, { action: "ess_registration_refused", module: "users", recordType: "employee", recordId: v.employee_no, remarks: `Did not match HR: ${match.fields.join(", ") || "unspecified"}${ref}` });
    const which = match.fields.length ? ` These do not match: ${match.fields.join(", ")}.` : "";
    return { errors: { form: `${NO_MATCH}${which}` }, values: v };
  }
  if (match.refused === "invalid") {
    await audit(req, { action: "ess_registration_refused", module: "users", recordType: "employee", recordId: v.employee_no, remarks: `HR could not check the details: ${match.fields.join(", ") || "unspecified"}${ref}` });
    const which = match.fields.length ? ` Check: ${match.fields.join(", ")}.` : "";
    return { errors: { form: `Please check your details and try again: HR could not check them as entered.${which}` }, values: v };
  }
  if (match.refused === "not_eligible" || !["active", "on_leave"].includes(match.emp.employment_status)) {
    await audit(req, { action: "ess_registration_refused", module: "users", recordType: "employee", recordId: v.employee_no, remarks: `HR: not eligible${ref}` });
    return { errors: { form: NOT_ELIGIBLE }, values: v };
  }
  const { emp } = match;
  if (await selectOne("SELECT id FROM users WHERE employee_id = ? AND deleted_at IS NULL", [emp.id]))
    return { errors: { form: "This employee already has an account. Sign in, or use Forgot password." }, values: v };

  const roleCode = roleForPosition(emp.department_code, emp.position_title);
  const hash = await bcrypt.hash(password, 12);
  const privacy = String(await getSetting("privacy.notice_version", "1"));
  const result = await tx(async (trx) => {
    const role = await selectOne("SELECT id, name FROM roles WHERE code = ?", [roleCode], trx);
    const { insertId: userId } = await exec(
      "INSERT INTO users (employee_id, role_id, email, full_name, password_hash, must_change_password, privacy_ack_version, privacy_ack_at) VALUES (?,?,?,?,?,0,?,NOW())",
      [emp.id, role.id, v.email, v.full_name, hash, privacy], trx);
    const { insertId } = await exec(
      `INSERT INTO employee_verification_records (employee_id, hr_employee_id, employee_no, full_name, department_name, position_title, email, password_hash, hr_check, status, user_id, privacy_ack_version, ip_address)
       VALUES (?,?,?,?,?,?,?, '', ?, 'activated', ?, ?, ?)`,
      [emp.id, emp.hr_employee_id, emp.employee_no, v.full_name, emp.department_name, emp.position_title, v.email, match.check, userId, privacy, String(req.ip || "").slice(0, 45)], trx);
    await audit(req, { action: "ess_account_activated", module: "users", recordType: "user", recordId: userId, next: { employee_no: emp.employee_no, department: emp.department_code, position: emp.position_title, role: roleCode, hr_check: match.check, hr_reference: match.reference } }, trx);
    // HR learns that the new hire now has credentials (it may show it on the employee's record)
    await enqueue("hr", "EmployeeAccountActivated", emp.hr_employee_id, { employee_id: emp.hr_employee_id, employee_no: emp.employee_no, email: v.email, department_code: emp.department_code, position_title: emp.position_title, activated_at: new Date().toISOString() }, trx);
    return { id: insertId, userId, roleName: role.name };
  });
  return { ...result, department: emp.department_name, departmentCode: emp.department_code, position: emp.position_title, signsInHere: emp.department_code === accountingDepartment() || roleCode === "employee" };
}

export const registrations = () =>
  select(`SELECT r.id, r.employee_no, r.full_name, r.department_name, r.position_title, r.email, r.hr_check, r.status, r.created_at, ro.name AS role_name
            FROM employee_verification_records r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN roles ro ON ro.id = u.role_id
           ORDER BY r.id DESC LIMIT 200`);

// ---- sign-in for the other departments' applications (POST /api/integration/v1/auth/login) ------------------------------------
// Team decision 2026-11-16: CRM and Inventory create a deactivated access account from HR's employee list and activate it
// on the employee's first successful sign-in here. Only employees of the calling application's department, registered in
// ESS and Active (or On Leave) in HR, are accepted. Every attempt is audited. Never returns salary, bank, government ID or
// password data. The department codes of each application come from .env (HR's codes may differ from JVzPay's defaults).
const DEPARTMENT_ENV = { johnvivz_crm: ["CRM_DEPARTMENT_CODES", "CRM"], johnvivz_inventory: ["INVENTORY_DEPARTMENT_CODES", "INVENTORY"], johnvivz_hr: ["HR_DEPARTMENT_CODES", "HR"] };
export const departmentCodesFor = (source) => {
  const [name, fallback] = DEPARTMENT_ENV[source] || [];
  if (!name) return [];
  return String(process.env[name] || fallback).split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
};
const INVALID = { error: "invalid_credentials" }, NOT_ALLOWED = { error: "not_allowed" };
const manilaIso = (d) => (d ? `${new Date(new Date(d).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19)}+08:00` : null);

export async function departmentSignIn(req, client, { email, password }) {
  const codes = departmentCodesFor(client.source);
  const mail = String(email || "").trim().toLowerCase().slice(0, 190);
  const user = mail ? await selectOne(
    `SELECT u.*, r.code AS role_code, e.hr_employee_id, e.hr_employee_code, e.employee_no, e.employment_status, d.code AS department_code, d.name AS department_name, p.title AS position_title
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN employees e ON e.id = u.employee_id AND e.deleted_at IS NULL
       LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions p ON p.id = e.position_id
      WHERE u.email = ? AND u.deleted_at IS NULL`, [mail]) : null;
  // the same answer for an unknown email, a wrong password, a lock and an unregistered employee: nobody can tell which
  const answer = async (status, body, reason) => {
    await audit(req, { action: status === 200 ? "department_login" : "department_login_refused", module: "auth", recordType: "user", recordId: user?.id ?? mail.slice(0, 40),
      remarks: `${client.source}: ${reason}`, actor: user ? { id: user.id, full_name: user.full_name } : null });
    return { status, body };
  };
  if (!user) return answer(401, INVALID, "unknown email");
  if (user.locked_until && new Date(user.locked_until) > new Date()) return answer(401, INVALID, "locked");
  if (!(await bcrypt.compare(String(password || "").slice(0, 200), user.password_hash))) {
    const { env } = await import("../config/env.js");
    const attempts = user.failed_login_attempts + 1;
    if (attempts >= env.maxFailedLogins) await exec("UPDATE users SET failed_login_attempts = 0, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?", [env.lockoutMinutes, user.id]);
    else await exec("UPDATE users SET failed_login_attempts = ? WHERE id = ?", [attempts, user.id]);
    return answer(401, INVALID, "wrong password");
  }
  if (!user.employee_id || !user.hr_employee_id) return answer(401, INVALID, "not an ESS-registered employee");
  if (!["active", "on_leave"].includes(user.employment_status)) return answer(403, NOT_ALLOWED, `employment ${user.employment_status}`);
  if (user.status !== "active") return answer(403, NOT_ALLOWED, `ESS account ${user.status}`);
  if (!codes.includes(String(user.department_code || "").toUpperCase())) return answer(403, NOT_ALLOWED, `employee belongs to ${user.department_code || "no department"}`);
  const reg = await selectOne("SELECT created_at FROM employee_verification_records WHERE user_id = ? AND status = 'activated' ORDER BY id LIMIT 1", [user.id]);
  await exec("UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?", [user.id]);
  return answer(200, {
    employee_id: user.hr_employee_id,
    employee_code: user.hr_employee_code || null,
    full_name: user.full_name,
    email: user.email,
    department_code: user.department_code,
    department_name: user.department_name,
    position: user.position_title,
    employment_status: user.employment_status,
    ess_registered_at: manilaIso(reg?.created_at || user.created_at),
  }, "signed in");
}
