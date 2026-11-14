// Accounting Staff account requests (Module: user accounts).
// A person asks for an account with their employee name, employee ID, position and the unique code from HR. Until the HR
// database is connected those details cannot be confirmed, so an Accounting Supervisor approves or rejects each request by hand,
// and every screen shows that the person was not checked with HR.
import bcrypt from "bcrypt";
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { encrypt } from "../lib/crypto.js";
import { notifyPermission } from "../lib/notify.js";
import { checkPassword } from "../lib/validate.js";
import { badRequest, notFound } from "../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { verifyEmployee } from "./hrDirectoryService.js";
import { getSetting } from "../lib/settings.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates the sign-up form. Returns the cleaned values and field errors. */
export function checkRequest(body) {
  const v = {
    full_name: String(body.full_name || "").trim().replace(/\s+/g, " "),
    employee_no: String(body.employee_no || "").trim().toUpperCase(),
    department_id: String(body.department_id || "").trim(),
    position_title: String(body.position_title || "").trim(),
    hr_code: String(body.hr_code || "").trim(),
    email: String(body.email || "").trim().toLowerCase(),
  };
  const password = String(body.password || ""), confirm = String(body.confirm_password || "");
  const errors = {};
  if (!v.full_name) errors.full_name = "Enter your full name as HR has it.";
  else if (v.full_name.length > 160) errors.full_name = "Use at most 160 characters.";
  if (!/^[A-Z0-9-]{2,40}$/.test(v.employee_no)) errors.employee_no = "Enter your employee ID (letters, numbers and dashes).";
  if (!/^\d+$/.test(v.department_id)) errors.department_id = "Choose your department.";
  if (!v.position_title) errors.position_title = "Enter your position.";
  else if (v.position_title.length > 120) errors.position_title = "Use at most 120 characters.";
  if (!v.hr_code) errors.hr_code = "Enter the unique code HR gave you.";
  else if (v.hr_code.length > 64) errors.hr_code = "That code is too long.";
  if (!EMAIL.test(v.email) || v.email.length > 190) errors.email = "Enter a valid email address.";
  const problem = checkPassword(password, v.email);
  if (problem) errors.password = problem;
  if (password !== confirm) errors.confirm_password = "Passwords do not match.";
  if (body.privacy_ack !== "1") errors.privacy_ack = "Confirm that you have read the Privacy Notice.";
  return { values: v, password, errors };
}

export async function submitRequest(req, body) {
  const { values: v, password, errors } = checkRequest(body);
  if (!errors.email && (await selectOne("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", [v.email])))
    errors.email = "An account with this email already exists. Sign in instead.";
  if (!errors.employee_no && (await selectOne("SELECT id FROM account_requests WHERE status = 'pending' AND (employee_no = ? OR email = ?)", [v.employee_no, v.email])))
    errors.employee_no = "A request for this employee ID or email is already waiting for approval.";
  if (Object.keys(errors).length) return { errors, values: v };

  const validPosition = await selectOne(
    `SELECT p.id
       FROM positions p
       JOIN departments d ON d.id = p.department_id
      WHERE p.title = ? AND p.department_id = ? AND p.is_active = 1 AND p.deleted_at IS NULL
        AND d.is_active = 1 AND d.deleted_at IS NULL`,
    [v.position_title, v.department_id]
  );
  if (!validPosition) return { errors: { position_title: "Choose a position from the selected department." }, values: v };

  const hr = await verifyEmployee(v);
  if (hr.status === "not_found") return { errors: { form: "HR has no active employee with these details. Check them with HR." }, values: v };

  return tx(async (trx) => {
    const { insertId } = await exec(
      `INSERT INTO account_requests (full_name, employee_no, position_title, hr_code_enc, email, password_hash, hr_check, ip_address, privacy_ack_version)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [v.full_name, v.employee_no, v.position_title, encrypt(v.hr_code), v.email, await bcrypt.hash(password, 12), hr.status, String(req.ip || "").slice(0, 45), String(await getSetting("privacy.notice_version", "1"))], trx);
    await notifyPermission("users.manage", {
      type: "account_request", title: "Accounting staff account requested",
      message: `${v.full_name} (${v.employee_no}, ${v.position_title}) asked for an Accounting Staff account.`,
      relatedType: "account_request", relatedId: insertId, link: `/users/requests/${insertId}`,
    }, {}, trx);
    await audit(req, { action: "account_requested", module: "users", recordType: "account_request", recordId: insertId, next: { full_name: v.full_name, employee_no: v.employee_no, position_title: v.position_title, email: v.email, hr_check: hr.status } }, trx);
    return { id: insertId };
  });
}

export async function listRequests(req) {
  const t = tableState(req, { sortable: { submitted: "a.created_at", name: "a.full_name", status: "a.status" }, defaultSort: "submitted", defaultDir: "desc" });
  const status = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : req.query.status === "all" ? "" : "pending";
  const where = [], params = [];
  if (status) { where.push("a.status = ?"); params.push(status); }
  if (t.q) { where.push("(a.full_name LIKE ? OR a.employee_no LIKE ? OR a.email LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM account_requests a ${W}`, params));
  const rows = await select(
    `SELECT a.id, a.full_name, a.employee_no, a.position_title, a.email, a.status, a.hr_check, a.created_at, a.decided_at, u.full_name AS decided_by_name
       FROM account_requests a LEFT JOIN users u ON u.id = a.decided_by ${W} ORDER BY ${t.orderBy}, a.id DESC LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows, t, status: status || "all", meta: tableMeta(req, t, total, { status: status || "all" }) };
}

export async function getRequest(id) {
  const r = await selectOne(
    `SELECT a.id, a.full_name, a.employee_no, a.position_title, a.email, a.status, a.hr_check, a.user_id, a.decided_at, a.decision_remarks, a.ip_address, a.created_at,
            u.full_name AS decided_by_name
       FROM account_requests a LEFT JOIN users u ON u.id = a.decided_by WHERE a.id = ?`, [id]);
  if (!r) throw notFound("Account request not found.");
  return r;
}

export async function decideRequest(req, id, action, remarks) {
  const note = String(remarks || "").trim().slice(0, 500);
  if (!["approve", "reject"].includes(action)) throw badRequest("Choose approve or reject.");
  if (action === "reject" && !note) throw badRequest("Give a reason for rejecting; the person sees it when they try to sign in.");
  return tx(async (trx) => {
    const r = await selectOne("SELECT * FROM account_requests WHERE id = ? FOR UPDATE", [id], trx);
    if (!r) throw notFound("Account request not found.");
    if (r.status !== "pending") throw badRequest("This request was already decided.");
    let userId = null;
    if (action === "approve") {
      if (await selectOne("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", [r.email], trx)) throw badRequest("An account with this email already exists.");
      const role = await selectOne("SELECT id FROM roles WHERE code = 'accounting_staff'", [], trx);
      if (!role) throw badRequest("The Accounting Staff role is missing. Run the database migrations.");
      ({ insertId: userId } = await exec(
        "INSERT INTO users (employee_id, role_id, email, full_name, password_hash, must_change_password, privacy_ack_version, privacy_ack_at, created_by) VALUES (NULL,?,?,?,?,0,?,?,?)",
        [role.id, r.email, r.full_name, r.password_hash, r.privacy_ack_version, r.privacy_ack_version ? r.created_at : null, req.user.id], trx));
    }
    // data minimization: the HR code is not needed after a decision; an approved password now lives only on the account
    await exec("UPDATE account_requests SET status = ?, user_id = ?, decided_by = ?, decided_at = NOW(), decision_remarks = ?, hr_code_enc = '', password_hash = IF(? = 'approve', '', password_hash) WHERE id = ?",
      [action === "approve" ? "approved" : "rejected", userId, req.user.id, note || null, action, id], trx);
    await audit(req, {
      action: action === "approve" ? "account_request_approved" : "account_request_rejected", module: "users", recordType: "account_request", recordId: id,
      decision: action === "approve" ? "approved" : "rejected", remarks: note || (r.hr_check === "not_connected" ? "Approved without an HR check (HR database not connected)." : null),
      next: { email: r.email, employee_no: r.employee_no, hr_check: r.hr_check, user_id: userId },
    }, trx);
    return { ...r, status: action === "approve" ? "approved" : "rejected", user_id: userId };
  });
}

/** For the sign-in page: tells someone with a request (and the right password) where it stands, instead of "invalid". */
export async function requestStatusForLogin(email, password) {
  const r = await selectOne("SELECT status, decision_remarks, password_hash FROM account_requests WHERE email = ? AND status IN ('pending','rejected') ORDER BY id DESC LIMIT 1", [email]);
  if (!r || !r.password_hash || !(await bcrypt.compare(password, r.password_hash))) return null;
  return r.status === "pending"
    ? "Your account request is waiting for approval by the Accounting Supervisor."
    : `Your account request was not approved: ${r.decision_remarks}`;
}
