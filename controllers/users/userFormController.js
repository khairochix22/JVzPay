/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// New/edit user account page (GET/POST /users/new, /users/:id/edit) and its security actions (reset password, unlock,
// sign out everywhere). Passwords are never chosen by the admin: a random temporary password is shown once.
import { select, selectOne, scalar, exec, tx } from "../../lib/db.js";
import { validate } from "../../lib/validate.js";
import { audit } from "../../lib/audit.js";
import { wrap, notFound, HttpError } from "../../lib/errors.js";
import { createResetLink } from "../../services/passwordResetService.js";
import { makeTempPassword, hashPassword, fullName } from "../../services/employeeService.js";

const roles = () => select("SELECT id, code, name FROM roles ORDER BY FIELD(code,'accounting_supervisor','accounting_staff','payroll_staff','employee')");
const linkableEmployees = (keepId = null) =>
  select(
    `SELECT e.id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, e.email FROM employees e
      WHERE e.deleted_at IS NULL AND (NOT EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.deleted_at IS NULL) OR e.id = ?)
      ORDER BY e.last_name, e.first_name`,
    [keepId]
  ).then((rows) => rows.map((e) => ({ ...e, name: fullName(e) })));

const activeSupervisors = () =>
  scalar("SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'accounting_supervisor' AND u.status = 'active' AND u.deleted_at IS NULL");


const schema = {
  full_name: { label: "Full name", required: true, max: 160 },
  email: { label: "Email", type: "email", required: true, max: 190 },
  role_id: { label: "Role", type: "id", required: true },
  employee_id: { label: "Linked employee", type: "id" },
};

async function checkRoleLink(values, errors) {
  const role = await selectOne("SELECT id, code FROM roles WHERE id = ?", [values.role_id]);
  if (!role) errors.role_id = "Select a valid role.";
  else if (role.code === "employee" && !values.employee_id) errors.employee_id = "Employee accounts must be linked to an employee record.";
  if (values.employee_id) {
    const e = await selectOne("SELECT id FROM employees WHERE id = ? AND deleted_at IS NULL", [values.employee_id]);
    if (!e) errors.employee_id = "Employee not found.";
  }
  return role;
}


async function loadUserRow(id) {
  const u = await selectOne(
    `SELECT u.*, r.code AS role_code, (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.deleted_at IS NULL`, [id]);
  if (!u) throw notFound("User not found.");
  return u;
}


export const editForm = wrap(async (req, res) => {
  const u = await loadUserRow(Number(req.params.id));
  const sessions = await select("SELECT ip_address, user_agent, updated_at FROM user_sessions WHERE user_id = ? AND expires_at > NOW() ORDER BY updated_at DESC", [u.id]);
  res.render("user-form", {
    title: "Edit user account", mode: "edit", u, roles: await roles(), employees: await linkableEmployees(u.employee_id), errors: {},
    isSelf: u.id === req.user.id, sessions,
  });
});

export const update = wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await loadUserRow(id);
  const { values, errors } = validate(req.body, { ...schema, status: { label: "Status", type: "enum", values: ["active", "inactive"], required: true } });
  const role = Object.keys(errors).length ? null : await checkRoleLink(values, errors);
  if (!errors.email) {
    const dupe = await selectOne("SELECT id FROM users WHERE email = ? AND id <> ?", [values.email, id]);
    if (dupe) errors.email = "Another account already uses this email.";
  }
  if (values.employee_id && !errors.employee_id) {
    const dupe = await selectOne("SELECT id FROM users WHERE employee_id = ? AND id <> ? AND deleted_at IS NULL", [values.employee_id, id]);
    if (dupe) errors.employee_id = "This employee is already linked to another account.";
  }
  // Guard rails: a supervisor cannot lock themselves out, and the system can never lose its last active Accounting Supervisor.
  if (id === req.user.id && role && role.code !== cur.role_code) errors.role_id = "You cannot change your own role.";
  if (id === req.user.id && values.status !== "active") errors.status = "You cannot deactivate your own account.";
  if (cur.role_code === "accounting_supervisor" && role && (role.code !== "accounting_supervisor" || values.status !== "active") && Number(await activeSupervisors()) <= 1)
    errors.role_id = "This is the only active Accounting Supervisor. Create another Accounting Supervisor first.";

  if (Object.keys(errors).length) {
    return res.status(422).render("user-form", { title: "Edit user account", mode: "edit", u: { ...cur, ...values, id }, roles: await roles(), employees: await linkableEmployees(cur.employee_id), errors, isSelf: id === req.user.id, sessions: [] });
  }
  await tx(async (trx) => {
    await exec("UPDATE users SET full_name = ?, email = ?, role_id = ?, employee_id = ?, status = ? WHERE id = ?",
      [values.full_name, values.email, values.role_id, values.employee_id, values.status, id], trx);
    if (values.status !== "active" || Number(values.role_id) !== Number(cur.role_id)) {
      await exec("DELETE FROM user_sessions WHERE user_id = ?", [id], trx); // revoke access immediately
    }
    await audit(req, {
      action: "user_updated", module: "users", recordType: "user", recordId: id,
      previous: { full_name: cur.full_name, email: cur.email, role: cur.role_code, employee_id: cur.employee_id, status: cur.status },
      next: { full_name: values.full_name, email: values.email, role: role.code, employee_id: values.employee_id, status: values.status },
    }, trx);
  });
  req.flash("success_msg", "User account updated.");
  res.redirect(`/users/${id}/edit`);
});

export const resetPassword = wrap(async (req, res) => {
  const id = Number(req.params.id);
  const u = await loadUserRow(id);
  if (id === req.user.id) { req.flash("error_msg", "Use “Change password” to change your own password."); return res.redirect(`/users/${id}/edit`); }
  const temp = makeTempPassword();
  await tx(async (trx) => {
    await exec("UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_attempts = 0, locked_until = NULL WHERE id = ?", [await hashPassword(temp), id], trx);
    await exec("DELETE FROM user_sessions WHERE user_id = ?", [id], trx);
    await audit(req, { action: "password_reset_by_admin", module: "users", recordType: "user", recordId: id }, trx);
  });
  req.flash("success_msg", `Password reset for ${u.email}. Temporary password: ${temp} — shown only once; the user must change it at next sign-in.`);
  res.redirect(`/users/${id}/edit`);
});

export const unlock = wrap(async (req, res) => {
  const id = Number(req.params.id);
  await loadUserRow(id);
  await exec("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?", [id]);
  await audit(req, { action: "user_unlocked", module: "users", recordType: "user", recordId: id });
  req.flash("success_msg", "Account unlocked.");
  res.redirect(`/users/${id}/edit`);
});

export const revokeSessions = wrap(async (req, res) => {
  const id = Number(req.params.id);
  await loadUserRow(id);
  await exec("DELETE FROM user_sessions WHERE user_id = ? AND sid <> ?", [id, req.sessionID]);
  await audit(req, { action: "sessions_revoked", module: "users", recordType: "user", recordId: id });
  req.flash("success_msg", "All sessions for this account were signed out.");
  res.redirect(`/users/${id}/edit`);
});

// One-time password reset link (expires, works once); shown here once for the Accounting Supervisor to pass on.
export const resetLink = wrap(async (req, res) => {
  try {
    const link = await createResetLink(req, Number(req.params.id));
    const until = new Date(link.expiresAt).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
    req.flash("success_msg", `Password reset link for ${link.email}. Give it to them now; it works once and expires at ${until}: ${link.url}`);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    req.flash("error_msg", e.message);
  }
  res.redirect(`/users/${req.params.id}/edit`);
});
