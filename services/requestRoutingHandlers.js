// RequestDecided from HR: the employee's immediate supervisor or team leader (who has no JVzPay account) decided a leave,
// attendance correction, overtime or vacation leave conversion request that JVzPay sent to HR. Since 2026-11-13 this is
// the FIRST approval: an approval sends the request to Accounting/Payroll for the final decision; a rejection ends it with
// the usual rules (reserved leave days returned) and HR receives the outcome.
import { selectOne } from "../lib/db.js";
import { registerHandlers, eventFail as fail, eventNeed as need, eventStr as str } from "./integrationService.js";
import { decideFirst, KINDS } from "./supervisorApproval.js";

async function requestDecided(d) {
  need(d, ["request_type", "request_no", "decision", "approver_name"]);
  if (!KINDS[d.request_type]) fail("data.request_type must be leave, attendance_correction, overtime or leave_conversion.");
  if (!["approved", "rejected"].includes(d.decision)) fail("data.decision must be approved or rejected.");
  if (d.decision === "rejected" && !str(d.remarks, 500)) fail("data.remarks is required when rejecting.");
  const k = KINDS[d.request_type];
  const row = await selectOne(`SELECT id, employee_id, routed_to, status, supervisor_status FROM ${k.table} WHERE ${k.no} = ?`, [str(d.request_no, 30)]);
  if (!row) fail(`Request ${d.request_no} is not in JVzPay.`);
  if (row.routed_to !== "department") fail(`Request ${d.request_no} is approved by the immediate supervisor inside JVzPay, not through HR.`);
  if (row.status !== "pending") fail(`Request ${d.request_no} was already ${row.status}.`);
  if (row.supervisor_status !== "pending") fail(`Request ${d.request_no} was already ${row.supervisor_status} by the immediate supervisor.`);
  const approver = d.approver_employee_id ? await selectOne("SELECT id FROM employees WHERE hr_employee_id = ?", [str(d.approver_employee_id, 40)]) : null;
  if (approver && approver.id === row.employee_id) fail("An employee cannot decide their own request.");
  // the team leader has no JVzPay account: the decision carries their name and role
  const req = { user: { id: null, employee_id: approver?.id ?? null, full_name: str(d.approver_name, 160), role_code: "department_supervisor", can: () => true }, ip: null, get: () => null };
  try {
    await decideFirst(req, d.request_type, row.id, d.decision, str(d.remarks, 500));
  } catch (e) {
    fail(e.message);
  }
  return `${d.request_no} ${d.decision} by ${d.approver_name} (immediate supervisor)${d.decision === "approved" ? "; waiting for Accounting/Payroll" : ""}`;
}

registerHandlers("johnvivz_hr", { RequestDecided: requestDecided });
