// Two-step approval for leave, vacation leave conversion, overtime and attendance corrections. Everything is done in
// ESS (team decision 2026-11-16: approvals are never routed to HR):
//   1. the employee's immediate supervisor or team leader in the SAME department approves (or rejects — which ends it);
//   2. then Accounting/Payroll Staff or the Accounting Supervisor give the final decision.
// Nobody gives both approvals of one request, and nobody decides their own.
// Who approves first (the supervisor comes from HR: employees.supervisor_hr_id):
//   • HR's named supervisor works in the same department and has an active ESS account → Team Approvals ('user');
//   • otherwise a Payroll/Accounting employee → the Accounting Supervisors ('role');
//   • otherwise, in another department → its supervisors/managers ranked ABOVE the requester (DEPARTMENT_SUPERVISOR_TITLES,
//     lib/orgSettings.js: CRM Manager and Team Leader, Inventory Manager and Inventory Supervisor, HR Manager and HR
//     Supervisor), any one of them with an active ESS account ('department');
//   • otherwise — the department's top title, or nobody above with an ESS account — the first approval is not required
//     ('none'): the request goes straight to the final approval, and the reason is kept in supervisor_remarks.
import { select, selectOne, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notify, notifyEmployee, notifyPermission } from "../lib/notify.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { fullName } from "./employeeService.js";
import { accountingDepartment, higherSupervisorTitles, normTitle } from "../lib/orgSettings.js";

// the requester's department and position, joined onto request rows (canApproveFirst needs them)
const REQUESTER_COLS = "d.code AS requester_dept_code, p.title AS requester_title";
const REQUESTER_JOIN = "JOIN employees e ON e.id = x.employee_id JOIN departments d ON d.id = e.department_id LEFT JOIN positions p ON p.id = e.position_id";

/** The department and position of a signed-in approver (for the department-supervisor rule). */
export async function approverContext(user, trx = null) {
  if (!user?.employee_id) return { dept_code: null, title: null };
  const r = await selectOne("SELECT d.code AS dept_code, p.title FROM employees e JOIN departments d ON d.id = e.department_id LEFT JOIN positions p ON p.id = e.position_id WHERE e.id = ?", [user.employee_id], trx);
  return r || { dept_code: null, title: null };
}

// table, its number column, the final-decision permission, the page that lists it, the service that decides it
export const KINDS = {
  leave: { table: "leave_applications", no: "application_no", perm: "leave.review", link: "/leave-requests", label: "Leave", decide: async () => (await import("./leaveAdminService.js")).decideLeave },
  overtime: { table: "overtime_records", no: "request_no", perm: "overtime.approve", link: "/overtime/review", label: "Overtime", decide: async () => (await import("./overtimeService.js")).decideOvertime },
  attendance_correction: { table: "attendance_correction_requests", no: "request_no", perm: "attendance.correction.review", link: "/attendance/corrections", label: "Attendance correction", decide: async () => (await import("./attendanceService.js")).decideCorrection },
  leave_conversion: { table: "leave_conversions", no: "conversion_no", perm: "leave.conversion.review", link: "/payroll/leave-conversions", label: "Vacation leave conversion", decide: async () => (await import("./leaveConversionService.js")).decideConversion },
};

/** Who approves an employee's requests first. */
export async function approverFor(employeeId, trx = null) {
  const emp = await selectOne(
    "SELECT e.id, e.supervisor_hr_id, e.department_id, d.code AS department_code, p.title AS position_title FROM employees e JOIN departments d ON d.id = e.department_id LEFT JOIN positions p ON p.id = e.position_id WHERE e.id = ?", [employeeId], trx);
  if (!emp) return { mode: "none", reason: "the employee record was not found" };
  let unregistered = null; // HR's named supervisor, in the department, without an ESS account yet
  if (emp.supervisor_hr_id) {
    const sup = await selectOne(
      `SELECT s.id, s.first_name, s.middle_name, s.last_name, s.suffix, s.department_id, s.employment_status, u.id AS user_id
         FROM employees s LEFT JOIN users u ON u.employee_id = s.id AND u.status = 'active' AND u.deleted_at IS NULL
        WHERE s.hr_employee_id = ? AND s.deleted_at IS NULL LIMIT 1`, [emp.supervisor_hr_id], trx);
    // a supervisor outside the department, or no longer employed, counts as no supervisor in the department
    if (sup && sup.id !== emp.id && sup.department_id === emp.department_id && ["active", "on_leave"].includes(sup.employment_status)) {
      if (sup.user_id) return { mode: "user", userId: sup.user_id, name: fullName(sup) };
      unregistered = fullName(sup); // fall back to the department's supervisors below
    }
  }
  if (emp.department_code === accountingDepartment()) {
    const isSupervisor = await selectOne(
      "SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.employee_id = ? AND r.code = 'accounting_supervisor' AND u.status = 'active' AND u.deleted_at IS NULL", [emp.id], trx);
    if (!isSupervisor) return { mode: "role", name: "Accounting Supervisor" };
    return { mode: "none", reason: "there is no higher supervisor in the department" };
  }
  // no immediate supervisor named by HR: the department's supervisors/managers ranked above the requester
  // (DEPARTMENT_SUPERVISOR_TITLES), when at least one of them has an active ESS account
  const higher = higherSupervisorTitles(emp.department_code, emp.position_title);
  if (higher.length) {
    const users = await departmentSupervisorUsers(emp.department_id, higher, emp.id, trx);
    if (users.length) return { mode: "department", userIds: users.map((u) => u.id), name: [...new Set(users.map((u) => u.title))].join(" / ") };
    return { mode: "none", reason: unregistered ? `the immediate supervisor (${unregistered}) and the department's supervisors have no active ESS account yet` : "no supervisor or manager of the department has an active ESS account yet" };
  }
  if (unregistered) return { mode: "none", reason: `the immediate supervisor (${unregistered}) has no active ESS account yet` };
  return { mode: "none", reason: "there is no higher supervisor in the department" };
}

/** Active ESS users of the department whose position is one of the (normalised) titles, excluding the requester. */
async function departmentSupervisorUsers(departmentId, titles, exceptEmployeeId, trx) {
  const rows = await select(
    `SELECT u.id, p.title FROM users u JOIN employees s ON s.id = u.employee_id JOIN positions p ON p.id = s.position_id
      WHERE s.department_id = ? AND s.id <> ? AND s.deleted_at IS NULL AND s.employment_status IN ('active','on_leave')
        AND u.status = 'active' AND u.deleted_at IS NULL`, [departmentId, exceptEmployeeId], trx);
  return rows.filter((r) => titles.includes(normTitle(r.title)));
}

/**
 * Called right after a request is saved: marks it as waiting for the immediate supervisor and tells them, or — when no
 * first approval is required — sends it straight to the final approvers.
 */
export async function startApproval(kind, id, approver, req, trx) {
  const k = KINDS[kind];
  const row = await selectOne(`SELECT ${k.no} AS no FROM ${k.table} WHERE id = ?`, [id], trx);
  if (approver.mode === "none") {
    await exec(`UPDATE ${k.table} SET supervisor_status = 'not_required', supervisor_user_id = NULL, supervisor_name = NULL, supervisor_remarks = ? WHERE id = ?`,
      [`First approval not required: ${approver.reason}.`.slice(0, 500), id], trx);
    await notifyPermission(k.perm, { type: `${kind}_final_approval`, title: `${k.label} ready for final approval`, message: `${req.user.full_name} filed ${row.no}. No first approval is required: ${approver.reason}.`, relatedType: k.table, relatedId: id, link: k.link }, { excludeUserId: req.user?.id ?? null }, trx);
    return;
  }
  await exec(`UPDATE ${k.table} SET supervisor_status = 'pending', supervisor_user_id = ?, supervisor_name = ? WHERE id = ?`,
    [approver.mode === "user" ? approver.userId : null, approver.name || null, id], trx);
  const payload = { type: `${kind}_first_approval`, title: `${k.label} for your approval`, message: `${req.user.full_name} filed ${row.no}. As their immediate supervisor, approve or reject it.`, relatedType: k.table, relatedId: id, link: "/team/approvals" };
  if (approver.mode === "user") await notify(approver.userId, payload, trx);
  else if (approver.mode === "department") { for (const uid of approver.userIds) if (uid !== req.user?.id) await notify(uid, payload, trx); }
  else if (approver.mode === "role") {
    const sups = await select("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'accounting_supervisor' AND u.status = 'active' AND u.id <> ?", [req.user.id || 0], trx);
    for (const s of sups) await notify(s.id, payload, trx);
  }
}

/** The final decision may only be given after the immediate supervisor approved, and never by that same person. */
export function guardFinal(row, req, opts = {}) {
  if (opts.asSupervisor) return;
  if (row.supervisor_status === "pending") {
    throw badRequest(`${row.application_no || row.request_no || row.conversion_no} is waiting for the immediate supervisor's approval${row.supervisor_name ? ` (${row.supervisor_name})` : ""}. Accounting/Payroll decide it after that.`);
  }
  if (row.supervisor_decided_by && req.user?.id && row.supervisor_decided_by === req.user.id) {
    throw forbidden("You gave the immediate supervisor's approval for this request; someone else in Accounting/Payroll must give the final approval.");
  }
}

/**
 * May this user give the first approval of this row? The row carries requester_dept_code / requester_title and ctx is the
 * user's own department and position (approverContext). Without a named supervisor: in Payroll/Accounting any Accounting
 * Supervisor; in another department a supervisor/manager of THAT department ranked above the requester.
 */
export function canApproveFirst(row, user, ctx = {}) {
  if (row.status !== "pending" || row.supervisor_status !== "pending") return false;
  if (row.employee_id === user.employee_id || row.submitted_by === user.id || row.requested_by === user.id) return false;
  if (row.supervisor_user_id) return row.supervisor_user_id === user.id;
  if (row.routed_to === "department") return false;
  if (!row.requester_dept_code || row.requester_dept_code === accountingDepartment()) return user.role_code === "accounting_supervisor";
  return ctx.dept_code === row.requester_dept_code && higherSupervisorTitles(row.requester_dept_code, row.requester_title).includes(normTitle(ctx.title));
}

/**
 * The immediate supervisor's decision. From JVzPay (a signed-in user) or from HR (req.user.id is null, routed to the
 * department). Approve: the request waits for Accounting/Payroll. Reject: the request is rejected with the usual rules.
 */
export async function decideFirst(req, kind, id, action, remarks) {
  const k = KINDS[kind];
  if (!k) throw notFound("Request not found.");
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting.");
  const row = await tx(async (trx) => {
    const r = await selectOne(`SELECT x.*, ${REQUESTER_COLS} FROM ${k.table} x ${REQUESTER_JOIN} WHERE x.id = ? FOR UPDATE`, [id], trx);
    if (!r) throw notFound("Request not found.");
    if (r.status !== "pending") throw badRequest(`${r[k.no]} was already ${r.status}.`);
    if (r.supervisor_status !== "pending") throw badRequest(`${r[k.no]} does not need the immediate supervisor's approval now.`);
    const fromHr = !req.user?.id;
    if (fromHr && r.routed_to !== "department") throw badRequest(`${r[k.no]} is approved first inside JVzPay, not through HR.`);
    if (!fromHr && !canApproveFirst(r, req.user, await approverContext(req.user, trx))) throw forbidden("Only the employee's immediate supervisor or a supervisor of their department can give this approval.");
    await exec(`UPDATE ${k.table} SET supervisor_status = ?, supervisor_name = ?, supervisor_decided_by = ?, supervisor_decided_at = NOW(), supervisor_remarks = ? WHERE id = ?`,
      [action, req.user?.full_name || r.supervisor_name, req.user?.id ?? null, remarks || null, id], trx);
    await audit(req, { action: `${kind}_supervisor_${action}`, module: "approvals", recordType: k.table, recordId: id, decision: action, remarks, next: { no: r[k.no], step: "immediate supervisor" } }, trx);
    if (action === "approved") {
      await notifyPermission(k.perm, { type: `${kind}_final_approval`, title: `${k.label} ready for final approval`, message: `${r[k.no]} was approved by the immediate supervisor (${req.user?.full_name || "team leader"}).`, relatedType: k.table, relatedId: id, link: k.link }, { excludeUserId: req.user?.id ?? null }, trx);
      await notifyEmployee(r.employee_id, { type: `${kind}_supervisor_approved`, title: `${k.label} approved by your supervisor`, message: `${r[k.no]} now goes to Accounting/Payroll for the final approval.`, relatedType: k.table, relatedId: id }, trx);
    }
    return r;
  });
  // a rejection ends the request with the usual rules (reserved leave days returned, HR told the outcome)
  if (action === "rejected") await (await k.decide())(req, id, "rejected", remarks, { asSupervisor: true });
  return row;
}

/** Team Approvals: what this user has to approve first. */
export async function teamQueue(user) {
  const out = [];
  const ctx = await approverContext(user);
  for (const [kind, k] of Object.entries(KINDS)) {
    const rows = await select(
      `SELECT x.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department, ${REQUESTER_COLS}
         FROM ${k.table} x ${REQUESTER_JOIN}
        WHERE x.status = 'pending' AND x.supervisor_status = 'pending'
          AND (x.supervisor_user_id = ? OR (x.supervisor_user_id IS NULL AND x.routed_to = 'accounting'))
        ORDER BY x.id`, [user.id]);
    for (const r of rows) if (canApproveFirst(r, user, ctx)) out.push({ ...r, kind, kindLabel: k.label, no: r[k.no], name: fullName(r) });
  }
  return out;
}

export async function teamCount(user) {
  return (await teamQueue(user)).length;
}

/** SQL: a request the final approvers may act on now (first approval given, or not needed). */
export const READY_SQL = "supervisor_status IN ('approved','not_required')";
