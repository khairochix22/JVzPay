// Employee account registration (owner's flow, 2026-11-13; master prompt §IV).
//   1. HR encodes the new hire (with personal email), assigns department and position, and generates the Employee ID
//      and a unique code. HR sends that record to JVzPay (EmployeeCreated, see docs/API_INTEGRATION.md).
//   2. The new hire registers here with Employee ID, unique code, full name, email, department and position, and
//      chooses a password. Every field must match HR's record — the email must be the one HR encoded, which proves the
//      person controls it — and the employee must be active with no account yet.
//   3. The account is activated at once. It opens only the application of the employee's own department: Payroll/
//      Accounting staff sign in to JVzPay with the role their position calls for; everyone else signs in to their own
//      department's application (CRM, Inventory, HR), which checks the credentials through JVzPay's login API.
//      Every employee also keeps their Self-Service pages (payslips, leave, attendance) in JVzPay.
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { select, selectOne, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { checkPassword } from "../lib/validate.js";
import { badRequest } from "../lib/errors.js";
import { getSetting } from "../lib/settings.js";
import { targetConfig, enqueue } from "./integrationService.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const NO_MATCH = "These details do not match an active employee in HR's records. Check them with HR: Employee ID, unique code, name, email, department and position must all be exactly as HR encoded them.";

// the JVzPay department; its people get a working role in JVzPay from their position
export const ACCOUNTING_DEPARTMENT = "PAYROLL_ACCOUNTING";
const ROLE_BY_POSITION = { "accounting supervisor": "accounting_supervisor", "accounting staff": "accounting_staff", "payroll staff": "payroll_staff" };
export const roleForPosition = (deptCode, positionTitle) =>
  deptCode === ACCOUNTING_DEPARTMENT ? ROLE_BY_POSITION[norm(positionTitle)] || "employee" : "employee";

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
  if (!/^[A-Z0-9-]{2,20}$/.test(v.employee_no)) errors.employee_no = "Enter your employee ID (letters, numbers and dashes).";
  if (!v.verification_code || v.verification_code.length > 64) errors.verification_code = "Enter the unique code HR gave you.";
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

const nameMatches = (typed, emp) => {
  const words = norm(typed).split(" ");
  return words.includes(norm(emp.first_name).split(" ")[0]) && norm(typed).includes(norm(emp.last_name));
};

/** Ask HR's API when it is configured; otherwise compare with the record HR synchronised into JVzPay. */
async function verifyWithHr(v, dept) {
  const emp = await selectOne(
    `SELECT e.*, d.code AS department_code, d.name AS department_name, p.title AS position_title FROM employees e
       JOIN departments d ON d.id = e.department_id JOIN positions p ON p.id = e.position_id
      WHERE e.employee_no = ? AND e.deleted_at IS NULL AND e.hr_employee_id IS NOT NULL`, [v.employee_no]);
  const hr = targetConfig("hr");
  if (hr.connected) {
    try {
      const res = await fetch(`${hr.url}/api/v1/employees/verify`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${hr.token}` }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ employee_id: v.employee_no, full_name: v.full_name, email: v.email, department: dept.name, position: v.position_title, verification_reference: v.verification_code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.match || !body.eligible) return null;
      return emp ? { emp, check: "hr_api" } : null; // payroll needs the record HR synchronised, too
    } catch {
      throw badRequest("The HR system could not be reached. Try again in a few minutes.");
    }
  }
  if (!emp) return null;
  const ok = nameMatches(v.full_name, emp)
    && emp.department_id === Number(v.department_id) && norm(emp.position_title) === norm(v.position_title)
    && !!emp.email && emp.email.trim().toLowerCase() === v.email
    && !!emp.hr_verification_hash && emp.hr_verification_hash === sha256(v.verification_code.toUpperCase());
  return ok ? { emp, check: "hr_snapshot" } : null;
}

export async function register(req, body) {
  const { values: v, password, errors } = checkForm(body);
  if (!errors.email && (await selectOne("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", [v.email])))
    errors.email = "An account with this email already exists. Sign in instead.";
  if (Object.keys(errors).length) return { errors, values: v };
  const dept = await selectOne("SELECT id, code, name FROM departments WHERE id = ?", [v.department_id]);
  if (!dept) return { errors: { department_id: "Choose your department." }, values: v };

  const match = await verifyWithHr(v, dept);
  if (!match || !["active", "on_leave"].includes(match.emp.employment_status)) {
    await audit(req, { action: "ess_registration_refused", module: "users", recordType: "employee", recordId: v.employee_no, remarks: "Details did not match HR" });
    return { errors: { form: NO_MATCH }, values: v };
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
    await audit(req, { action: "ess_account_activated", module: "users", recordType: "user", recordId: userId, next: { employee_no: emp.employee_no, department: emp.department_code, position: emp.position_title, role: roleCode, hr_check: match.check } }, trx);
    // HR learns that the new hire now has credentials (it may show it on the employee's record)
    await enqueue("hr", "EmployeeAccountActivated", emp.hr_employee_id, { employee_id: emp.hr_employee_id, employee_no: emp.employee_no, email: v.email, department_code: emp.department_code, position_title: emp.position_title, activated_at: new Date().toISOString() }, trx);
    return { id: insertId, userId, roleName: role.name };
  });
  return { ...result, department: emp.department_name, departmentCode: emp.department_code, position: emp.position_title, signsInHere: emp.department_code === ACCOUNTING_DEPARTMENT || roleCode === "employee" };
}

export const registrations = () =>
  select(`SELECT r.id, r.employee_no, r.full_name, r.department_name, r.position_title, r.email, r.hr_check, r.status, r.created_at, ro.name AS role_name
            FROM employee_verification_records r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN roles ro ON ro.id = u.role_id
           ORDER BY r.id DESC LIMIT 200`);

// ---- sign-in for the other departments' applications (POST /api/v1/auth/login) ---------------------------------------------
// The token decides which department may sign in: a CRM token accepts only CRM employees, and so on.
const DEPARTMENT_BY_SOURCE = { johnvivz_crm: "CRM", johnvivz_inventory: "INVENTORY", johnvivz_hr: "HR" };

export async function departmentSignIn(req, client, { email, password }) {
  const deptCode = DEPARTMENT_BY_SOURCE[client.source];
  const mail = String(email || "").trim().toLowerCase();
  const user = mail ? await selectOne(
    `SELECT u.*, r.code AS role_code, e.hr_employee_id, e.employee_no, e.employment_status, d.code AS department_code, d.name AS department_name, p.title AS position_title
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions p ON p.id = e.position_id
      WHERE u.email = ? AND u.deleted_at IS NULL`, [mail]) : null;
  const refuse = async (reason, status = 401) => {
    await audit(req, { action: "department_login_refused", module: "auth", recordType: "user", recordId: user?.id ?? mail.slice(0, 40), remarks: `${client.source}: ${reason}`, actor: user ? { id: user.id, full_name: user.full_name } : null });
    return { status, body: { authenticated: false, error: status === 423 ? "The account is locked for a while after too many wrong passwords." : "Invalid email or password, or this account is not for this application." } };
  };
  if (!user) return refuse("unknown email");
  if (user.locked_until && new Date(user.locked_until) > new Date()) return refuse("locked", 423);
  if (!(await bcrypt.compare(String(password || ""), user.password_hash))) {
    const { env } = await import("../config/env.js");
    const attempts = user.failed_login_attempts + 1;
    if (attempts >= env.maxFailedLogins) await exec("UPDATE users SET failed_login_attempts = 0, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?", [env.lockoutMinutes, user.id]);
    else await exec("UPDATE users SET failed_login_attempts = ? WHERE id = ?", [attempts, user.id]);
    return refuse("wrong password");
  }
  if (user.status !== "active") return refuse("account inactive");
  if (!deptCode || user.department_code !== deptCode) return refuse(`employee belongs to ${user.department_code || "no department"}`, 403);
  if (!["active", "on_leave"].includes(user.employment_status)) return refuse(`employment ${user.employment_status}`, 403);
  await exec("UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?", [user.id]);
  await audit(req, { action: "department_login", module: "auth", recordType: "user", recordId: user.id, remarks: client.source, actor: { id: user.id, full_name: user.full_name } });
  return {
    status: 200,
    body: {
      authenticated: true,
      user: { email: user.email, full_name: user.full_name, employee_id: user.hr_employee_id, employee_no: user.employee_no, department_code: user.department_code, department_name: user.department_name, position_title: user.position_title, employment_status: user.employment_status },
    },
  };
}
