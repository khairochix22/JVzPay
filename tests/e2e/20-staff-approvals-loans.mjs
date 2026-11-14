// Accounting Staff and Payroll Staff approve or reject employees' requests (never their own), and salary loans:
// eligibility, the policy limits, approval by staff, release by Payroll, repayment through payroll.
import { Client, check, report, db, errText, iso, daysFrom } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;

const maria = new Client(base), paolo = new Client(base), carla = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await paolo.login("paolo@johnvivz.local", "Rotated2026ok"); // password changed in stage 12
await carla.login("carla@johnvivz.local", "Welcome2026ok");
for (const c of [maria, paolo, carla]) await c.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
const M = await selectOne("SELECT e.* FROM employees e JOIN users u ON u.employee_id = e.id WHERE u.email = 'maria@johnvivz.local'");

// ---- staff decide employees' requests
let r = await carla.get("/dashboard");
check("Accounting Staff see the employee request queues in the sidebar", r.text.includes('href="/leave-requests"') && r.text.includes('href="/overtime/review"')
  && r.text.includes('href="/attendance/corrections"') && r.text.includes('href="/payroll/enrollments"') && r.text.includes('href="/payroll/loans"'));
for (const [path, who] of [["/leave-requests", carla], ["/overtime/review", carla], ["/attendance/corrections", carla], ["/bank-enrollments", carla], ["/payroll/leave-conversions", paolo], ["/payroll/retirement", carla], ["/payroll/loans", paolo]]) {
  r = await who.get(path);
  check(`${who === carla ? "Accounting" : "Payroll"} Staff open ${path}`, r.status === 200, `${r.status}`);
}
const vl = await selectOne("SELECT id FROM leave_types WHERE code = 'VL'");
const day = (() => { const d = daysFrom(45); while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1); return iso(d); })();
const t = await maria.csrf("/my/leave");
r = await maria.multipart("/my/leave/applications", { _csrf: t, leave_type_id: String(vl.id), start_date: day, end_date: day, reason: "Staff approval test" });
const lv = await selectOne("SELECT * FROM leave_applications WHERE reason = 'Staff approval test'");
// the immediate supervisor approves first (Maria has none on record: an Accounting Supervisor)
const grace = new Client(base);
await grace.login("grace@johnvivz.local", "Welcome2026ok");
await grace.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
await grace.submit("/team/approvals", `/team/approvals/leave/${lv.id}/decision`, { action: "approve", remarks: "" });
check("Maria files a leave", r.status === 302 && !!lv, errText(r));
r = await paolo.get(`/leave-requests/${lv.id}`);
check("Payroll Staff get the decision form", r.text.includes('value="approve"'));
r = await paolo.submit(`/leave-requests/${lv.id}`, `/leave-requests/${lv.id}/decision`, { action: "approve", remarks: "" });
check("Payroll Staff approve the leave", (await selectOne("SELECT status FROM leave_applications WHERE id = ?", [lv.id])).status === "approved");
r = await maria.submit("/my/overtime", "/my/overtime/applications", { work_date: iso(daysFrom(-9)), start_time: "18:00", end_time: "19:00", reason: "Staff approval OT" });
const ot = await selectOne("SELECT * FROM overtime_records WHERE reason = 'Staff approval OT'");
await grace.submit("/team/approvals", `/team/approvals/overtime/${ot.id}/decision`, { action: "approve", remarks: "" });
r = await carla.submit("/overtime/review", `/overtime/${ot.id}/decision`, { action: "reject", remarks: "Not pre-approved" });
check("Accounting Staff reject an overtime application with a reason", (await selectOne("SELECT status, decision_remarks FROM overtime_records WHERE id = ?", [ot.id])).decision_remarks === "Not pre-approved");

// ---- salary loan
r = await maria.get("/my/loans");
check("My Salary Loan shows eligibility and the limit (2 × basic 12,180 = 24,360)", r.status === 200 && r.text.includes("Eligible") && r.text.includes("₱24,360.00"));
r = await maria.get("/my/loans?principal=10000&term_months=12");
check("the quote shows interest, total and the payday deduction", r.text.includes("₱1,200.00") && r.text.includes("₱11,200.00") && r.text.includes("₱466.67"));
r = await maria.submit("/my/loans", "/my/loans", { principal: "30000", term_months: "12", purpose: "Home repair" });
check("more than 2 months of basic salary is refused", r.status === 400 && r.text.includes("up to 2 months"));
r = await maria.submit("/my/loans", "/my/loans", { principal: "20000", term_months: "3", purpose: "Home repair" });
check("a payday deduction above 25% of payday basic pay is refused", r.status === 400 && r.text.includes("more than 25%"));
r = await maria.submit("/my/loans", "/my/loans", { principal: "10000", term_months: "12", purpose: "Home repair" });
const loan = await selectOne("SELECT * FROM salary_loans WHERE employee_id = ?", [M.id]);
check("a ₱10,000 loan over 12 months is applied for", r.status === 302 && loan?.status === "pending" && loan.total_payable === "11200.00" && loan.amortization === "466.67" && loan.paydays === 24, errText(r));
r = await maria.submit("/my/loans", "/my/loans", { principal: "2000", term_months: "3", purpose: "Second loan" });
check("one loan at a time", r.status === 400 && r.text.includes("One loan at a time"));
r = await maria.submit("/payroll/loans", `/payroll/loans/${loan.id}/decision`, { action: "approve" });
check("employees cannot decide loans", r.status === 403);
r = await paolo.submit("/payroll/loans", `/payroll/loans/${loan.id}/release`, { reference: "CHK-1" });
check("a loan is not released before approval", (await selectOne("SELECT status FROM salary_loans WHERE id = ?", [loan.id])).status === "pending");
r = await carla.submit("/payroll/loans", `/payroll/loans/${loan.id}/decision`, { action: "approve", remarks: "" });
check("Accounting Staff approve the loan", (await selectOne("SELECT status FROM salary_loans WHERE id = ?", [loan.id])).status === "approved");
r = await carla.submit("/payroll/loans", `/payroll/loans/${loan.id}/release`, { reference: "CHK-1" });
check("Accounting Staff cannot release money (403)", r.status === 403);
r = await paolo.submit("/payroll/loans", `/payroll/loans/${loan.id}/release`, { reference: "CHK-000777" });
const after = await selectOne("SELECT l.status, l.pay_item_id, i.amount, i.remaining_balance, i.status AS item_status FROM salary_loans l LEFT JOIN employee_pay_items i ON i.id = l.pay_item_id WHERE l.id = ?", [loan.id]);
check("Payroll Staff release it: a LOAN deduction of 466.67 with an 11,200.00 balance", after.status === "released" && after.amount === "466.67" && after.remaining_balance === "11200.00" && after.item_status === "approved", JSON.stringify(after));
const je = await selectOne("SELECT id, total_debit FROM journal_entries WHERE source_type = 'salary_loan' AND source_id = ?", [loan.id]);
const lines = Object.fromEntries((await select("SELECT a.code, l.debit, l.credit FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = ?", [je?.id])).map((l) => [l.code, Number(l.debit) || -Number(l.credit)]));
check("the release journal: receivable 11,200, cash 10,000, interest income 1,200", lines["1100"] === 11200 && lines["1020"] === -10000 && lines["4020"] === -1200, JSON.stringify(lines));
r = await maria.get("/my/loans");
check("Maria sees the loan being repaid", r.text.includes("CHK-000777") && r.text.includes("₱11,200.00 left"));

await sequelize.close();
report();
