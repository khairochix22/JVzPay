// Two-step approval (owner, 2026-11-13) for leave, vacation leave conversion, overtime and attendance corrections:
//   1. the employee's immediate supervisor or team leader approves (or rejects — which ends the request);
//   2. only then Accounting/Payroll Staff or the Accounting Supervisor give the final decision.
// Nobody gives both approvals of one request, and nobody decides their own.
// Who the immediate supervisor is comes from HR (employees.supervisor_hr_id):
//   • the supervisor has a JVzPay account → they decide under Team Approvals ('user');
//   • the supervisor has no JVzPay account, or HR has not named one for an employee outside Payroll/Accounting → the
//     request goes to HR, which returns the team leader's decision as RequestDecided ('hr', routed_to = 'department');
//   • a Payroll/Accounting employee with no supervisor on record → any Accounting Supervisor ('role').
import { select, selectOne, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notify, notifyEmployee, notifyPermission } from "../lib/notify.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { fullName } from "./employeeService.js";

const ACCOUNTING_DEPARTMENT = "PAYROLL_ACCOUNTING";

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
    "SELECT e.id, e.supervisor_hr_id, d.code AS department_code FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = ?", [employeeId], trx);
  if (emp?.supervisor_hr_id) {
    const sup = await selectOne(
      `SELECT s.id, s.first_name, s.middle_name, s.last_name, s.suffix, u.id AS user_id
         FROM employees s LEFT JOIN users u ON u.employee_id = s.id AND u.status = 'active' AND u.deleted_at IS NULL
        WHERE s.hr_employee_id = ? AND s.deleted_at IS NULL LIMIT 1`, [emp.supervisor_hr_id], trx);
    if (sup?.user_id && sup.id !== emp.id) return { mode: "user", userId: sup.user_id, name: fullName(sup) };
    return { mode: "hr", name: sup ? fullName(sup) : null };
  }
  if (!emp || emp.department_code === ACCOUNTING_DEPARTMENT) return { mode: "role", name: "Accounting Supervisor" };
  return { mode: "hr", name: null };
}

/** Called right after a request is saved: marks it as waiting for the immediate supervisor and tells them. */
export async function startApproval(kind, id, approver, req, trx) {
  const k = KINDS[kind];
  await exec(`UPDATE ${k.table} SET supervisor_status = 'pending', supervisor_user_id = ?, supervisor_name = ? WHERE id = ?`,
    [approver.mode === "user" ? approver.userId : null, approver.name || null, id], trx);
  const row = await selectOne(`SELECT ${k.no} AS no FROM ${k.table} WHERE id = ?`, [id], trx);
  const payload = { type: `${kind}_first_approval`, title: `${k.label} for your approval`, message: `${req.user.full_name} filed ${row.no}. As their immediate supervisor, approve or reject it.`, relatedType: k.table, relatedId: id, link: "/team/approvals" };
  if (approver.mode === "user") await notify(approver.userId, payload, trx);
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

/** May this user give the first approval of this row? */
export function canApproveFirst(row, user) {
  if (row.status !== "pending" || row.supervisor_status !== "pending") return false;
  if (row.employee_id === user.employee_id || row.submitted_by === user.id || row.requested_by === user.id) return false;
  if (row.supervisor_user_id) return row.supervisor_user_id === user.id;
  return row.routed_to !== "department" && user.role_code === "accounting_supervisor";
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
    const r = await selectOne(`SELECT * FROM ${k.table} WHERE id = ? FOR UPDATE`, [id], trx);
    if (!r) throw notFound("Request not found.");
    if (r.status !== "pending") throw badRequest(`${r[k.no]} was already ${r.status}.`);
    if (r.supervisor_status !== "pending") throw badRequest(`${r[k.no]} does not need the immediate supervisor's approval now.`);
    const fromHr = !req.user?.id;
    if (fromHr && r.routed_to !== "department") throw badRequest(`${r[k.no]} is approved first inside JVzPay, not through HR.`);
    if (!fromHr && !canApproveFirst(r, req.user)) throw forbidden("Only the employee's immediate supervisor can give this approval.");
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
  for (const [kind, k] of Object.entries(KINDS)) {
    const rows = await select(
      `SELECT x.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department
         FROM ${k.table} x JOIN employees e ON e.id = x.employee_id JOIN departments d ON d.id = e.department_id
        WHERE x.status = 'pending' AND x.supervisor_status = 'pending'
          AND (x.supervisor_user_id = ? OR (x.supervisor_user_id IS NULL AND x.routed_to = 'accounting' AND ? = 'accounting_supervisor'))
        ORDER BY x.id`, [user.id, user.role_code]);
    for (const r of rows) if (canApproveFirst(r, user)) out.push({ ...r, kind, kindLabel: k.label, no: r[k.no], name: fullName(r) });
  }
  return out;
}

export async function teamCount(user) {
  return (await teamQueue(user)).length;
}

/** SQL: a request the final approvers may act on now (first approval given, or not needed). */
export const READY_SQL = "supervisor_status IN ('approved','not_required')";
