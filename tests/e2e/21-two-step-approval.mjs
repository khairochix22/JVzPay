// Two-step approval (owner, 2026-11-13): the immediate supervisor or team leader approves first; only then may
// Accounting/Payroll Staff or the Accounting Supervisor give the final approval — never the same person twice.
import { Client, check, report, db, errText, iso, daysFrom } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, exec, sequelize } = db;

const maria = new Client(base), paolo = new Client(base), grace = new Client(base), carla = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await paolo.login("paolo@johnvivz.local", "Rotated2026ok"); // password changed in stage 12
await grace.login("grace@johnvivz.local", "Welcome2026ok");
await carla.login("carla@johnvivz.local", "Welcome2026ok");
for (const c of [maria, paolo, grace, carla]) await c.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
const M = await selectOne("SELECT e.* FROM employees e JOIN users u ON u.employee_id = e.id WHERE u.email = 'maria@johnvivz.local'");
const P = await selectOne("SELECT e.* FROM employees e JOIN users u ON u.employee_id = e.id WHERE u.email = 'paolo@johnvivz.local'");
const ot = async (reason, daysAgo) => {
  await maria.submit("/my/overtime", "/my/overtime/applications", { work_date: iso(daysFrom(-daysAgo)), start_time: "18:00", end_time: "19:00", reason });
  return selectOne("SELECT * FROM overtime_records WHERE reason = ?", [reason]);
};

// ---- an ordinary staff member has plain Self-Service: no Team Approvals
let r0 = await maria.get("/dashboard");
check("an ordinary employee has no Team Approvals tab", !r0.text.includes('href="/team/approvals"'));
r0 = await maria.get("/team/approvals");
check("and cannot open it (403)", r0.status === 403);
r0 = await carla.get("/team/approvals");
check("Accounting Staff with no team cannot either (403)", r0.status === 403);

// ---- Maria has no supervisor on record: an Accounting Supervisor approves first
await exec("UPDATE employees SET supervisor_hr_id = NULL WHERE id = ?", [M.id]);
let o = await ot("Two-step A", 11);
check("a new request waits for the immediate supervisor", o?.status === "pending" && o.supervisor_status === "pending" && o.supervisor_user_id === null, JSON.stringify(o));
let r = await paolo.submit("/overtime/review", `/overtime/${o.id}/decision`, { action: "approve", remarks: "" });
check("Accounting/Payroll cannot give the final approval before the supervisor", (await selectOne("SELECT status FROM overtime_records WHERE id = ?", [o.id])).status === "pending");
r = await paolo.get("/overtime/review");
check("the queue shows it is waiting for the supervisor", r.text.includes("Waiting for"));
r = await grace.get("/team/approvals");
check("the Accounting Supervisor sees it under Team Approvals", r.status === 200 && r.text.includes(o.request_no));
r = await paolo.get("/team/approvals");
check("staff who are not the supervisor do not", !r.text.includes(o.request_no));
r = await paolo.submit("/team/approvals", `/team/approvals/overtime/${o.id}/decision`, { action: "approve" });
check("and cannot give the first approval (403)", r.status === 403);
r = await grace.submit("/team/approvals", `/team/approvals/overtime/${o.id}/decision`, { action: "approve" });
o = await selectOne("SELECT * FROM overtime_records WHERE id = ?", [o.id]);
check("the supervisor approves first; the request stays pending", o.supervisor_status === "approved" && o.status === "pending" && o.supervisor_name === "Grace Villanueva");
r = await grace.submit("/overtime/review", `/overtime/${o.id}/decision`, { action: "approve", remarks: "" });
check("the same person cannot also give the final approval", (await selectOne("SELECT status FROM overtime_records WHERE id = ?", [o.id])).status === "pending");
r = await carla.submit("/overtime/review", `/overtime/${o.id}/decision`, { action: "approve", remarks: "" });
check("Accounting Staff give the final approval", (await selectOne("SELECT status FROM overtime_records WHERE id = ?", [o.id])).status === "approved");

// ---- HR names Paolo as Maria's team leader: Paolo approves first in JVzPay
await exec("UPDATE employees SET supervisor_hr_id = ? WHERE id = ?", [P.hr_employee_id, M.id]);
o = await ot("Two-step B", 12);
check("the request goes to the team leader HR named", o?.supervisor_status === "pending" && o.supervisor_user_id !== null && o.supervisor_name === "Paolo Reyes", JSON.stringify(o));
r = await grace.get("/team/approvals");
check("then the Accounting Supervisor is not the first approver", !r.text.includes(o.request_no));
r = await paolo.get("/dashboard");
check("once HR names him Team Leader, Paolo gets the Team Approvals tab with a badge", /Team Approvals<\/span>\s*<span class="nav-link__count">\d+</.test(r.text));
r = await paolo.submit("/team/approvals", `/team/approvals/overtime/${o.id}/decision`, { action: "reject" });
check("a rejection needs a reason", (await selectOne("SELECT supervisor_status FROM overtime_records WHERE id = ?", [o.id])).supervisor_status === "pending");
r = await paolo.submit("/team/approvals", `/team/approvals/overtime/${o.id}/decision`, { action: "reject", remarks: "Not needed" });
o = await selectOne("SELECT * FROM overtime_records WHERE id = ?", [o.id]);
check("the team leader's rejection ends the request", o.status === "rejected" && o.supervisor_status === "rejected");

// ---- leave: first the team leader, then the final approval; balances move only at the end
const vl = await selectOne("SELECT id FROM leave_types WHERE code = 'VL'");
const day = (() => { const d = daysFrom(60); while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1); return iso(d); })();
const t = await maria.csrf("/my/leave");
await maria.multipart("/my/leave/applications", { _csrf: t, leave_type_id: String(vl.id), start_date: day, end_date: day, reason: "Two-step leave" });
let lv = await selectOne("SELECT * FROM leave_applications WHERE reason = 'Two-step leave'");
r = await maria.get("/my/leave");
check("Maria sees whom her leave waits for", r.text.includes("Waiting for Paolo Reyes"));
r = await paolo.get(`/leave-requests/${lv.id}`);
check("the final-approval page shows no decision form yet", !r.text.includes('value="approve"') && r.text.includes("Waiting for the immediate supervisor"));
await paolo.submit("/team/approvals", `/team/approvals/leave/${lv.id}/decision`, { action: "approve", remarks: "OK from the team" });
r = await paolo.get(`/leave-requests/${lv.id}`);
check("after his first approval Paolo still cannot give the final one", !r.text.includes('value="approve"') && r.text.includes("Approved by the immediate supervisor"));
await carla.submit(`/leave-requests/${lv.id}`, `/leave-requests/${lv.id}/decision`, { action: "approve", remarks: "" });
lv = await selectOne("SELECT * FROM leave_applications WHERE id = ?", [lv.id]);
check("Accounting Staff give the final approval", lv.status === "approved" && lv.supervisor_status === "approved");
await exec("UPDATE employees SET supervisor_hr_id = NULL WHERE id = ?", [M.id]);

await sequelize.close();
report();
