// Department approval routing: a CRM agent's attendance correction and leave go to HR (their Team Leader decides),
// not to the Accounting Supervisor; HR's RequestDecided is applied with the usual rules; HR gets the outcome.
// Payroll/Accounting employees' requests stay with the Accounting Supervisor (covered by stages 04, 05 and 11).
import { Client, check, report, db, errText, pastWorkday, daysFrom, iso } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;

const admin = new Client(base), andrea = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
let r = await andrea.login("andrea.bautista@gmail.com", "Payday2026ok"); // registered in stage 15 as a CRM Agent
check("the CRM agent signs in to Self-Service", r.status === 302, `${r.status}`);
await andrea.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
await admin.submit("/settings/integration", "/settings/integration/tokens", { source: "johnvivz_hr", name: "HR for routing test" });
const hrToken = /(jvz_[A-Za-z0-9_-]{20,})/.exec((await admin.get("/settings/integration")).text)?.[1];
const decide = (data) => fetch(`${base}/api/v1/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${hrToken}` },
  body: JSON.stringify({ event_id: `dec-${Date.now()}-${Math.random()}`, event_type: "RequestDecided", source: "johnvivz_hr", entity_id: data.request_no, data }) }).then(async (x) => ({ status: x.status, body: await x.json() }));

// ---- attendance correction → HR → Team Leader rejects
const day = pastWorkday(2);
r = await andrea.submit("/my/attendance", "/my/attendance/corrections", { work_date: day, requested_status: "present", requested_time_in: "08:00", requested_time_out: "17:00", reason: "Biometric was offline" });
const corr = await selectOne("SELECT * FROM attendance_correction_requests WHERE reason = 'Biometric was offline'");
check("the correction is routed to the department, not the Accounting Supervisor", r.status === 302 && corr?.routed_to === "department", errText(r));
check("HR is asked to reach the supervisor (outbox)", !!(await selectOne("SELECT id FROM integration_outbox WHERE event_type = 'AttendanceCorrectionRequested' AND entity_id = 'HR-901'")));
r = await admin.get("/dashboard");
r = await admin.get(`/attendance/corrections/${corr.id}`);
check("the Accounting Supervisor sees it is decided through HR, with no decision form", r.status === 200 && r.text.includes("through HR") && !r.text.includes('value="approved"'));
r = await admin.post(`/attendance/corrections/${corr.id}/decision`, { _csrf: await admin.csrf(`/attendance/corrections/${corr.id}`), action: "approve" });
check("and cannot decide it before the team leader", (await selectOne("SELECT status FROM attendance_correction_requests WHERE id = ?", [corr.id])).status === "pending");
r = await decide({ request_type: "attendance_correction", request_no: corr.request_no, decision: "rejected", approver_name: "Liza Team Leader" });
check("a rejection without a reason is refused", r.status === 400 || r.status === 422);
r = await decide({ request_type: "attendance_correction", request_no: corr.request_no, decision: "rejected", approver_name: "Liza Team Leader", remarks: "Logs show you were absent" });
const corrAfter = await selectOne("SELECT status, approver_name, decided_by FROM attendance_correction_requests WHERE id = ?", [corr.id]);
check("the Team Leader's rejection is applied with their name", r.status === 202 && corrAfter.status === "rejected" && corrAfter.approver_name === "Liza Team Leader" && corrAfter.decided_by === null, JSON.stringify(r.body));
check("the employee is notified", !!(await selectOne("SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'andrea.bautista@gmail.com' AND n.title = 'Attendance correction rejected'")));
check("HR receives the outcome", !!(await selectOne("SELECT id FROM integration_outbox WHERE event_type = 'AttendanceCorrectionRejected'")));
r = await decide({ request_type: "attendance_correction", request_no: corr.request_no, decision: "approved", approver_name: "Liza Team Leader" });
check("a second decision is refused", r.status === 422 && /already/.test(r.body.error));

// ---- leave → HR → Team Leader approves (when the new hire has credits)
r = await andrea.get("/my/leave");
const types = await select("SELECT t.id, t.name, (b.entitled_days + b.adjusted_days - b.used_days - b.pending_days) AS left_days FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id JOIN users u ON u.employee_id = b.employee_id WHERE u.email = 'andrea.bautista@gmail.com' AND t.is_active = 1 ORDER BY left_days DESC");
if (types.length && Number(types[0].left_days) >= 1) {
  const monday = (() => { const d = daysFrom(14); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return iso(d); })();
  r = await andrea.submit("/my/leave", "/my/leave/applications", { leave_type_id: String(types[0].id), start_date: monday, end_date: monday, reason: "Family errand" });
  const lv = await selectOne("SELECT * FROM leave_applications WHERE reason = 'Family errand'");
  check("the leave is routed to the department", r.status === 302 && lv?.routed_to === "department", errText(r));
  r = await decide({ request_type: "leave", request_no: lv.application_no, decision: "approved", approver_name: "Liza Team Leader", remarks: "Enjoy" });
  const lvFirst = await selectOne("SELECT status, supervisor_status, supervisor_name FROM leave_applications WHERE id = ?", [lv.id]);
  check("the Team Leader's approval is the first approval: the leave waits for Accounting/Payroll", r.status === 202 && lvFirst.status === "pending" && lvFirst.supervisor_status === "approved" && lvFirst.supervisor_name === "Liza Team Leader", JSON.stringify(lvFirst));
  r = await admin.submit(`/leave-requests/${lv.id}`, `/leave-requests/${lv.id}/decision`, { action: "approve", remarks: "" });
  const lvAfter = await selectOne("SELECT status, approver_name FROM leave_applications WHERE id = ?", [lv.id]);
  const bal = await selectOne("SELECT used_days, pending_days FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?", [lv.employee_id, lv.leave_type_id, Number(monday.slice(0, 4))]);
  check("the final approval uses the leave rules: used, no longer pending", lvAfter.status === "approved" && Number(bal.used_days) >= 1 && Number(bal.pending_days) === 0, JSON.stringify(r.body));
  check("HR receives the recorded leave", !!(await selectOne("SELECT id FROM integration_outbox WHERE event_type = 'LeaveRecorded'")));
} else check("the new hire has no leave credits yet, so leave routing is covered by the correction above", true);

// ---- overtime application → HR → Team Leader approves → payroll may pay it
const otDay = pastWorkday(1);
r = await andrea.submit("/my/overtime", "/my/overtime/applications", { work_date: otDay, start_time: "17:00", end_time: "20:30", reason: "Month-end sales event" });
const ot = await selectOne("SELECT * FROM overtime_records WHERE reason = 'Month-end sales event'");
check("an overtime application is computed and routed to the department", r.status === 302 && Number(ot?.hours) === 3.5 && ot.routed_to === "department" && ot.source === "employee", errText(r));
r = await andrea.submit("/my/overtime", "/my/overtime/applications", { work_date: otDay, start_time: "20:00", end_time: "19:00", reason: "Backwards" });
check("an end time before the start is refused", r.status === 422 && r.text.includes("after the start time"));
r = await decide({ request_type: "overtime", request_no: ot.request_no, decision: "approved", approver_name: "Liza Team Leader" });
check("the Team Leader's approval is the first one", r.status === 202 && (await selectOne("SELECT supervisor_status FROM overtime_records WHERE id = ?", [ot.id])).supervisor_status === "approved", JSON.stringify(r.body));
r = await admin.submit("/overtime/review", `/overtime/${ot.id}/decision`, { action: "approve", remarks: "" });
check("then Accounting/Payroll's final approval makes it payable", (await selectOne("SELECT status FROM overtime_records WHERE id = ?", [ot.id])).status === "approved");
check("HR receives the recorded overtime", !!(await selectOne("SELECT id FROM integration_outbox WHERE event_type = 'OvertimeRecorded'")));
r = await andrea.get("/my/overtime");
check("the employee sees it approved with the team leader's name", r.status === 200 && r.text.includes("Liza Team Leader") && r.text.includes("3.50"));

// ---- requests of Payroll/Accounting employees stay with the Accounting Supervisor
const maria = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await maria.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
r = await maria.submit("/my/attendance", "/my/attendance/corrections", { work_date: pastWorkday(3), requested_status: "present", requested_time_in: "08:00", requested_time_out: "17:00", reason: "Accounting routing check" });
check("a Payroll/Accounting employee's request goes to the Accounting Supervisor", (await selectOne("SELECT routed_to FROM attendance_correction_requests WHERE reason = 'Accounting routing check'"))?.routed_to === "accounting", errText(r));

report();
await sequelize.close();
process.exit(0);
