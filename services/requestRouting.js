// Approval routing (team decision 2026-11-16): every approval is done in ESS, never through HR. The immediate supervisor
// in the same department approves first, or no first approval is needed (supervisorApproval.js); Accounting/Payroll
// give the final decision and keep the official record. Final outcomes are still queued for HR (reportOutcome), but
// only while HR_EVENTS_ENABLED is on — HR is pull-only today, so by default nothing is queued.
import { selectOne } from "../lib/db.js";
import { enqueue } from "./integrationService.js";
import { approverFor, guardFinal } from "./supervisorApproval.js";

export async function routeFor(employeeId, trx = null) {
  const emp = await selectOne(
    `SELECT e.id, e.hr_employee_id, e.employee_no, CONCAT(e.first_name, ' ', e.last_name) AS name, d.code AS department_code, d.name AS department_name, p.title AS position_title
       FROM employees e JOIN departments d ON d.id = e.department_id JOIN positions p ON p.id = e.position_id WHERE e.id = ?`, [employeeId], trx);
  const approver = await approverFor(employeeId, trx);
  return { emp, approver, routed: "accounting" };
}

/** The final decision waits for the immediate supervisor's approval and is never given by that same person. */
export function guardRouting(row, req, opts = {}) {
  guardFinal(row, req, opts);
}

/** Every final outcome goes to HR, which keeps a copy (Accounting/Payroll keeps the official record). */
export async function reportOutcome(kind, row, action, req, trx) {
  const emp = await selectOne("SELECT hr_employee_id FROM employees WHERE id = ?", [row.employee_id], trx);
  const type = { leave: ["LeaveRecorded", "LeaveRejected"], attendance_correction: ["AttendanceCorrected", "AttendanceCorrectionRejected"], overtime: ["OvertimeRecorded", "OvertimeRejected"], leave_conversion: ["LeaveConversionRecorded", "LeaveConversionRejected"] }[kind][action === "approved" ? 0 : 1];
  return enqueue("hr", type, emp?.hr_employee_id, {
    request_no: row.application_no || row.request_no || row.conversion_no, employee_id: emp?.hr_employee_id, decision: action, decided_by: req.user?.full_name || null,
    ...(kind === "leave" ? { start_date: String(row.start_date).slice(0, 10), end_date: String(row.end_date).slice(0, 10), days: Number(row.days) }
      : kind === "leave_conversion" ? { year: row.year, days: Number(row.days), amount: row.amount }
      : kind === "overtime" ? { work_date: String(row.work_date).slice(0, 10), start_time: row.start_time, end_time: row.end_time, hours: Number(row.hours), ot_type: row.ot_type }
      : { work_date: String(row.work_date).slice(0, 10), status: row.requested_status, time_in: row.requested_time_in, time_out: row.requested_time_out }),
  }, trx);
}
