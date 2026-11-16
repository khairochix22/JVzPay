// Approvals are done in ESS, never through HR (team decision 2026-11-16):
//   • first approval by the employee's immediate supervisor / Team Leader in the SAME department (their ESS account);
//   • final approval by Accounting/Payroll;
//   • no supervisor named by HR in the department (or one without an ESS account yet) → the department's supervisors /
//     managers ranked above the requester (CRM Manager, then Team Leader), any one of them;
//   • nobody above with an ESS account, or the department's top title → straight to the final approval, with the reason;
//   • a Payroll/Accounting employee without a supervisor on record → the Accounting Supervisors (unchanged).
// Supervisors come from HR's records (supervisor_employee_id), pulled by JVzPay.
import { Client, check, report, db, errText, pastWorkday } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;
const HR = process.env.HR_API_URL;
const hrCtl = (what, body) => fetch(`${HR}/__test/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const admin = new Client(base), andrea = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
const sync = () => admin.submit("/settings/integration", "/settings/integration/hr-sync", {});
let r = await andrea.login("andrea.bautista@gmail.com", "Payday2026ok"); // registered in stage 15 as a CRM Agent
check("the CRM agent signs in to Self-Service", r.status === 302, `${r.status}`);
await andrea.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
const andreaHr = { employee_id: "JV-2026-00901", first_name: "Andrea", middle_name: "Lopez", last_name: "Bautista", email: "andrea.bautista@gmail.com", department_id: 2, position: { title: "Agent" }, employment_status: "Active", hire_date: "2026-11-02", employee_code: "QX-5521-AB" };
const correction = async (client, day, reason) => {
  const res = await client.submit("/my/attendance", "/my/attendance/corrections", { work_date: day, requested_status: "present", requested_time_in: "08:00", requested_time_out: "17:00", reason });
  return { res, row: await selectOne("SELECT * FROM attendance_correction_requests WHERE reason = ?", [reason]) };
};

// ---- 1. no supervisor in the department → straight to Accounting/Payroll's final approval
let c = await correction(andrea, pastWorkday(2), "Biometric was offline");
check("no supervisor and no CRM Manager/Team Leader with an ESS account yet: straight to the final approval", c.res.status === 302 && c.row?.routed_to === "accounting" && c.row.supervisor_status === "not_required" && /no supervisor or manager of the department/.test(c.row.supervisor_remarks || ""), JSON.stringify(c.row) + errText(c.res));
r = await admin.get(`/attendance/corrections/${c.row.id}`);
check("the final approver sees why no first approval was needed, and can decide", r.status === 200 && r.text.includes("First approval not required") && r.text.includes('value="approve'));
r = await admin.submit(`/attendance/corrections/${c.row.id}`, `/attendance/corrections/${c.row.id}/decision`, { action: "reject", remarks: "Logs show you were absent" });
check("Accounting/Payroll decide it", (await selectOne("SELECT status FROM attendance_correction_requests WHERE id = ?", [c.row.id])).status === "rejected", errText(r));
check("the employee is notified", !!(await selectOne("SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'andrea.bautista@gmail.com' AND n.title = 'Attendance correction rejected'")));

// ---- 2. the Team Leader in the same department approves first, in ESS
await hrCtl("employees", [
  { employee_id: "JV-2026-00905", first_name: "Liza", last_name: "Mendoza", email: "liza.mendoza@gmail.com", department_id: 2, position: { title: "Team Leader" }, employment_status: "Active", hire_date: "2025-03-01", employee_code: "LZ-5050-MD" },
  { ...andreaHr, supervisor_employee_id: "JV-2026-00905" },
]);
r = await sync();
check("HR's supervisor reaches JVzPay with the pull sync", (await selectOne("SELECT supervisor_hr_id FROM employees WHERE hr_employee_id = 'JV-2026-00901'"))?.supervisor_hr_id === "JV-2026-00905", errText(r));
const crmDept = (await selectOne("SELECT id FROM departments WHERE code = 'CRM'")).id;
const anon = new Client(base);
r = await anon.submit("/register/employee", "/register/employee", { employee_no: "JV-2026-00905", verification_code: "LZ-5050-MD", full_name: "Liza Mendoza", email: "liza.mendoza@gmail.com", department_id: String(crmDept), position_title: "Team Leader", password: "Leader2026ok", confirm_password: "Leader2026ok", privacy_ack: "1" });
check("the Team Leader has an ESS account", r.status === 302, errText(r));
const liza = new Client(base);
await liza.login("liza.mendoza@gmail.com", "Leader2026ok");
await liza.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
const lizaUser = await selectOne("SELECT id FROM users WHERE email = 'liza.mendoza@gmail.com'");

const otDay = pastWorkday(1);
r = await andrea.submit("/my/overtime", "/my/overtime/applications", { work_date: otDay, start_time: "17:00", end_time: "20:30", reason: "Month-end sales event" });
const ot = await selectOne("SELECT * FROM overtime_records WHERE reason = 'Month-end sales event'");
check("the overtime waits for the Team Leader (her ESS account), not for HR", r.status === 302 && Number(ot?.hours) === 3.5 && ot.routed_to === "accounting" && ot.supervisor_status === "pending" && ot.supervisor_user_id === lizaUser.id, JSON.stringify(ot) + errText(r));
r = await andrea.get("/my/overtime");
check("the employee sees who approves first", r.text.includes("First Liza Mendoza, then Accounting/Payroll"));
r = await andrea.submit("/my/overtime", "/my/overtime/applications", { work_date: otDay, start_time: "20:00", end_time: "19:00", reason: "Backwards" });
check("an end time before the start is refused", r.status === 422 && r.text.includes("after the start time"));
await admin.submit("/overtime/review", `/overtime/${ot.id}/decision`, { action: "approve", remarks: "" });
check("Accounting/Payroll cannot decide before the Team Leader", (await selectOne("SELECT status FROM overtime_records WHERE id = ?", [ot.id])).status === "pending");
r = await liza.get("/team/approvals");
check("the Team Leader sees it under Team Approvals", r.status === 200 && r.text.includes(ot.request_no), `${r.status}`);
await liza.submit("/team/approvals", `/team/approvals/overtime/${ot.id}/decision`, { action: "approve", remarks: "" });
check("the Team Leader's approval is the first one", (await selectOne("SELECT supervisor_status, status FROM overtime_records WHERE id = ?", [ot.id])).supervisor_status === "approved");
await admin.submit("/overtime/review", `/overtime/${ot.id}/decision`, { action: "approve", remarks: "" });
check("then Accounting/Payroll's final approval makes it payable", (await selectOne("SELECT status FROM overtime_records WHERE id = ?", [ot.id])).status === "approved");

c = await correction(andrea, pastWorkday(3), "Forgot to punch out");
check("a correction also waits for the Team Leader", c.row?.supervisor_status === "pending" && c.row.supervisor_user_id === lizaUser.id);
r = await liza.submit("/team/approvals", `/team/approvals/attendance_correction/${c.row.id}/decision`, { action: "reject", remarks: "You left early that day" });
check("the Team Leader's rejection ends the request", (await selectOne("SELECT status FROM attendance_correction_requests WHERE id = ?", [c.row.id])).status === "rejected", errText(r));

// ---- 3. department supervisors by title: the Team Leader's own request goes to the CRM Manager; the Manager's own skips
c = await correction(liza, pastWorkday(4), "Team leader's own correction");
check("a Team Leader's request with no CRM Manager registered yet goes straight to the final approval", c.row?.supervisor_status === "not_required" && /no supervisor or manager/.test(c.row.supervisor_remarks || ""), JSON.stringify(c.row));
await hrCtl("employees", { employee_id: "JV-2026-00908", first_name: "Carmen", last_name: "Reyes", email: "carmen.reyes@gmail.com", department_id: 2, position: { title: "CRM Manager" }, employment_status: "Active", hire_date: "2023-06-01", employee_code: "CR-8080-RY" });
await sync();
r = await anon.submit("/register/employee", "/register/employee", { employee_no: "JV-2026-00908", verification_code: "CR-8080-RY", full_name: "Carmen Reyes", email: "carmen.reyes@gmail.com", department_id: String(crmDept), position_title: "CRM Manager", password: "Manager2026ok", confirm_password: "Manager2026ok", privacy_ack: "1" });
check("the CRM Manager has an ESS account", r.status === 302, errText(r));
const carmen = new Client(base);
await carmen.login("carmen.reyes@gmail.com", "Manager2026ok");
await carmen.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
c = await correction(liza, pastWorkday(8), "Team leader asks the manager");
check("now the Team Leader's request waits for the CRM Manager (department supervisor title)", c.row?.supervisor_status === "pending" && c.row.supervisor_user_id === null && /CRM Manager/.test(c.row.supervisor_name || ""), JSON.stringify(c.row));
r = await carmen.get("/team/approvals");
check("the CRM Manager sees it under Team Approvals (granted by her title)", r.status === 200 && r.text.includes(c.row.request_no), `${r.status}`);
// (the decision form, not the number: the submission's flash message shows the number on her next page)
check("the Team Leader cannot approve her own request", !(await liza.get("/team/approvals")).text.includes(`/team/approvals/attendance_correction/${c.row.id}/decision`));
await carmen.submit("/team/approvals", `/team/approvals/attendance_correction/${c.row.id}/decision`, { action: "approve", remarks: "" });
check("the CRM Manager's approval is the first approval", (await selectOne("SELECT supervisor_status, supervisor_decided_by FROM attendance_correction_requests WHERE id = ?", [c.row.id])).supervisor_status === "approved");
c = await correction(carmen, pastWorkday(9), "Manager's own correction");
check("the department's top title goes straight to the final approval", c.row?.supervisor_status === "not_required" && /no higher supervisor/.test(c.row.supervisor_remarks || ""), JSON.stringify(c.row));

// ---- 4. a supervisor in another department, or without an ESS account, does not approve
await hrCtl("employees", { ...andreaHr, supervisor_employee_id: "JV-2026-00902" }); // Rico, Payroll/Accounting
await sync();
c = await correction(andrea, pastWorkday(5), "Supervisor in another department");
check("a supervisor outside the department is not asked; the department's supervisors are", c.row?.supervisor_status === "pending" && c.row.supervisor_user_id === null && /CRM Manager/.test(c.row.supervisor_name || ""), JSON.stringify(c.row));
check("a Payroll/Accounting supervisor cannot approve a CRM agent's request", !(await admin.get("/team/approvals")).text.includes(c.row.request_no));
await hrCtl("employees", [
  { employee_id: "JV-2026-00906", first_name: "Mark", last_name: "Villanueva", email: "mark.v@gmail.com", department_id: 2, position: { title: "Team Leader" }, employment_status: "Active", hire_date: "2024-01-15", employee_code: "MV-6060-VL" },
  { ...andreaHr, supervisor_employee_id: "JV-2026-00906" },
]);
await sync();
c = await correction(andrea, pastWorkday(6), "Supervisor not registered yet");
check("HR's supervisor without an ESS account yet: the department's supervisors approve instead", c.row?.supervisor_status === "pending" && c.row.supervisor_user_id === null && /CRM Manager/.test(c.row.supervisor_name || ""), JSON.stringify(c.row));
await hrCtl("employees", { ...andreaHr, supervisor_employee_id: "JV-2026-00905" }); // back to Liza
await sync();

// ---- 5. Payroll/Accounting employees without a supervisor on record: the Accounting Supervisors, as before
const maria = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await maria.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
c = await correction(maria, pastWorkday(7), "Accounting routing check");
check("a Payroll/Accounting employee's request waits for the Accounting Supervisors", c.row?.routed_to === "accounting" && c.row.supervisor_status === "pending" && c.row.supervisor_user_id === null && c.row.supervisor_name === "Accounting Supervisor", JSON.stringify(c.row));

// ---- 6. nothing goes to HR
check("no request or outcome was queued for HR", (await select("SELECT id FROM integration_outbox WHERE target = 'hr'")).length === 0);
check("no request is routed to the department through HR", (await select("SELECT id FROM attendance_correction_requests WHERE routed_to = 'department' UNION ALL SELECT id FROM overtime_records WHERE routed_to = 'department'")).length === 0);

report();
await sequelize.close();
process.exit(0);
