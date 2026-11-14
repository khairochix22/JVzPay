// Time clock, weekly schedules with two days off, overtime on the schedule, vacation leave conversion and the
// retirement fund — through the real screens. Maria (Payroll/Accounting) is the employee; Paolo is Payroll Staff;
// Grace is the Accounting Supervisor.
import { Client, check, report, db, errText, iso } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, exec, sequelize } = db;

// back to the company's five-day week (stage 06 ran on a six-day week)
await exec("UPDATE system_settings SET setting_value = '261' WHERE setting_key = 'payroll.days_per_year'");
await exec("UPDATE system_settings SET setting_value = '6' WHERE setting_key = 'attendance.rest_day_2'");
const maria = new Client(base), paolo = new Client(base), grace = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await paolo.login("paolo@johnvivz.local", "Rotated2026ok"); // password changed in stage 12
await grace.login("grace@johnvivz.local", "Welcome2026ok");
for (const c of [maria, paolo, grace]) await c.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
const M = await selectOne("SELECT e.* FROM employees e JOIN users u ON u.employee_id = e.id WHERE u.email = 'maria@johnvivz.local'");
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const monday = (() => { const d = new Date(`${today}T00:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; })();
const dayOfWeek = (n) => { const d = new Date(monday); d.setDate(d.getDate() + n); return iso(d); }; // 0 = Monday … 6 = Sunday

// ---- 1. schedules are plotted by HR, day by day, and can change (days off included)
let r = await maria.get("/attendance/schedules");
check("employees cannot open Work Schedules (403)", r.status === 403);
r = await paolo.get("/attendance/schedules");
check("Payroll Staff see the roster; days HR has not plotted follow the default", r.status === 200 && r.text.includes("Dela Cruz") && r.text.includes("Default"));
await grace.submit("/settings/integration", "/settings/integration/tokens", { source: "johnvivz_hr", name: "HR schedules test" });
const hrToken = [...(await grace.get("/settings/integration")).text.matchAll(/(jvz_[A-Za-z0-9_-]{20,})/g)].map((x) => x[1]).pop();
const plot = (days) => fetch(`${base}/api/v1/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${hrToken}` },
  body: JSON.stringify({ event_id: `plot-${Date.now()}-${Math.random()}`, event_type: "ScheduleDaysPlotted", source: "johnvivz_hr", entity_id: M.hr_employee_id, data: { employee_id: M.hr_employee_id, days } }) })
  .then(async (x) => ({ status: x.status, body: await x.json() }));
const tue = dayOfWeek(1), wed = dayOfWeek(2), thu = dayOfWeek(3), sat = dayOfWeek(5), sun = dayOfWeek(6);
const late = { shift_start: "09:00", am_break_start: "11:00", lunch_start: "13:00", lunch_end: "14:00", pm_break_start: "16:00", shift_end: "18:00" };
r = await plot([{ date: tue, ...late, am_break_start: "13:30" }]);
check("HR's plot is refused when the times are out of order", r.status >= 400 && /must run/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
r = await plot([{ date: tue, ...late }, { date: wed, day_off: true }, { date: sat, shift_start: "08:00", am_break_start: "10:00", lunch_start: "12:00", lunch_end: "13:00", pm_break_start: "15:00", shift_end: "17:00" }, { date: sun, day_off: true }]);
check("HR plots Maria's week: a later shift on Tuesday, Wednesday off, Saturday working", r.status < 300 && Number((await selectOne("SELECT COUNT(*) n FROM schedule_days WHERE employee_id = ?", [M.id])).n) === 4, JSON.stringify(r.body));
check("Maria is told HR updated her schedule", !!(await selectOne("SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'maria@johnvivz.local' AND n.title = 'HR updated your schedule'")));
r = await paolo.get(`/attendance/schedules?week=${iso(monday)}`);
check("the roster shows what HR plotted", r.text.includes("09:00–18:00"));

const cal = (date) => maria.get(`/my/schedule?month=${date.slice(0, 7)}&date=${date}`);
r = await cal(tue);
check("My Schedule is a month calendar with clickable days", r.status === 200 && r.text.includes('class="mcal"') && (r.text.match(/class="mcal__cell/g) || []).length >= 28 && r.text.includes(`date=${tue}#day`));
check("clicking Tuesday shows its plotted shift, breaks, lunch and end of shift", r.text.includes("Plotted by HR") && r.text.includes("Start of shift") && r.text.includes("09:00")
  && r.text.includes("11:00–11:15") && r.text.includes("13:00–14:00") && r.text.includes("16:00–16:15") && r.text.includes("18:00") && r.text.includes("unpaid"));
r = await cal(wed);
check("Wednesday shows as a day off", r.text.includes("<strong>Day off</strong>"));
const live1 = JSON.parse((await maria.get(`/my/schedule/live?month=${tue.slice(0, 7)}`)).text).stamp;
check("the live check answers with a stamp", typeof live1 === "string" && live1.length > 0);
r = await plot([{ date: wed, ...late }, { date: thu, day_off: true }]);
check("HR moves the day off from Wednesday to Thursday", r.status < 300 && (await selectOne("SELECT is_day_off FROM schedule_days WHERE employee_id = ? AND work_date = ?", [M.id, wed])).is_day_off === 0);
const liveMoved = JSON.parse((await maria.get(`/my/schedule/live?month=${tue.slice(0, 7)}`)).text).stamp;
check("re-plotting changes the live stamp, so the open calendar reloads", liveMoved !== live1);
r = await cal(thu);
check("Thursday is now the day off", r.text.includes("<strong>Day off</strong>"));

// ---- 2. overtime appears on the schedule once approved
r = await maria.submit("/my/overtime", "/my/overtime/applications", { work_date: tue, start_time: "18:00", end_time: "20:00", reason: "Schedule test overtime" });
const ot = await selectOne("SELECT * FROM overtime_records WHERE reason = 'Schedule test overtime'");
check("Maria applies for two hours of overtime after her shift", r.status === 302 && Number(ot?.hours) === 2 && ot.routed_to === "accounting", errText(r));
r = await cal(tue);
check("pending overtime shows on the calendar and the day as pending", r.text.includes("OT 2.0h?") && r.text.includes("Overtime 18:00–20:00 · 2.00 h · pending"));
// two-step: Grace (Accounting Supervisor) approves first as Maria has no supervisor on record; Paolo gives the final approval
await grace.submit("/team/approvals", `/team/approvals/overtime/${ot.id}/decision`, { action: "approve", remarks: "" });
r = await paolo.submit("/overtime/review", `/overtime/${ot.id}/decision`, { action: "approve", remarks: "" });
check("Grace approves it first and Paolo gives the final approval", (await selectOne("SELECT status FROM overtime_records WHERE id = ?", [ot.id])).status === "approved");
const live2 = JSON.parse((await maria.get(`/my/schedule/live?month=${tue.slice(0, 7)}`)).text).stamp;
check("the live check changes, so the open page reloads by itself", live2 !== liveMoved);
r = await cal(tue);
check("approved overtime is on the day with the approver and the new end", r.text.includes("by Paolo Reyes") && r.text.includes("you end at <strong>20:00</strong>"));

// ---- 3. time clock
r = await maria.get("/my/clock");
check("Time Clock opens with Morning in and Afternoon in as the first steps", r.status === 200 && r.text.includes('value="am_in"') && r.text.includes('value="pm_in"') && !r.text.includes('value="am_out"'));
const already = await selectOne("SELECT COUNT(*) n FROM attendance_punches WHERE employee_id = ? AND work_date = ?", [M.id, today]);
const leaveToday = await selectOne("SELECT id FROM leave_applications WHERE employee_id = ? AND status = 'approved' AND ? BETWEEN start_date AND end_date AND days >= 1", [M.id, today]);
if (!already.n && !leaveToday) {
  r = await maria.submit("/my/clock", "/my/clock/punch", { punch_type: "am_out" });
  check("a step out of order is refused", r.status === 302 && !(await selectOne("SELECT id FROM attendance_punches WHERE employee_id = ? AND work_date = ?", [M.id, today])));
  for (const p of ["am_in", "am_break_start", "am_break_end", "am_out", "pm_in"]) await maria.submit("/my/clock", "/my/clock/punch", { punch_type: p });
  const punches = await select("SELECT punch_type FROM attendance_punches WHERE employee_id = ? AND work_date = ? ORDER BY id", [M.id, today]);
  check("five punches in order, the morning break included", punches.map((p) => p.punch_type).join(",") === "am_in,am_break_start,am_break_end,am_out,pm_in", punches.map((p) => p.punch_type).join(","));
  r = await maria.submit("/my/clock", "/my/clock/punch", { punch_type: "am_in" });
  check("the same punch twice is refused", Number((await selectOne("SELECT COUNT(*) n FROM attendance_punches WHERE employee_id = ? AND work_date = ? AND punch_type = 'am_in'", [M.id, today])).n) === 1);
  const rec = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ?", [M.id, today]);
  check("today's attendance comes from the punches and waits for validation", rec?.source === "punch" && rec.validation_status === "pending" && !!rec.time_in, JSON.stringify(rec));
  r = await maria.get("/my/clock");
  check("the clock offers the afternoon break or afternoon out next", r.text.includes('value="pm_break_start"') && r.text.includes('value="pm_out"') && !r.text.includes('value="am_in"'));
} else check("Maria already has punches or leave today; the order rules are covered by the unit tests", true);

// ---- 4. vacation leave: 10 days, converted to cash at year end
r = await maria.get("/my/leave");
const vl = await selectOne(`SELECT b.*, t.id AS type_id FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id WHERE b.employee_id = ? AND t.code = 'VL' AND b.year = YEAR(CURDATE())`, [M.id]);
check("every employee has 10 days of vacation leave this year", Number(vl?.entitled_days) === 10 && r.text.includes("Convert unused vacation leave to cash"));
const month = Number(today.slice(5, 7));
if (month !== 12 && month !== 1) {
  r = await maria.submit("/my/leave", "/my/leave/conversion", {});
  check("conversion outside 1 December – 31 January is refused", !(await selectOne("SELECT id FROM leave_conversions WHERE employee_id = ?", [M.id])));
}
// a year-end request as the December screen would record it (2 days at Maria's daily rate of ₱560)
await exec("INSERT INTO leave_conversions (conversion_no, employee_id, leave_type_id, year, days, daily_rate, amount, requested_by) VALUES ('VLC-T-0001', ?, ?, ?, 2.0, '560.00', '1120.00', (SELECT id FROM users WHERE email = 'maria@johnvivz.local'))", [M.id, vl.type_id, vl.year]);
await exec("UPDATE leave_balances SET pending_days = pending_days + 2 WHERE id = ?", [vl.id]);
const conv = await selectOne("SELECT * FROM leave_conversions WHERE conversion_no = 'VLC-T-0001'");
r = await maria.get("/payroll/leave-conversions");
check("employees cannot open the conversion queue (403)", r.status === 403);
r = await paolo.get("/payroll/leave-conversions");
check("Payroll Staff may decide conversions too", r.status === 200 && r.text.includes("VLC-T-0001"));
r = await grace.get("/payroll/leave-conversions");
check("the Accounting Supervisor sees the request", r.status === 200 && r.text.includes("VLC-T-0001"));
r = await grace.submit("/payroll/leave-conversions", `/payroll/leave-conversions/${conv.id}/decision`, { action: "approve" });
const vlAfter = await selectOne("SELECT used_days, pending_days FROM leave_balances WHERE id = ?", [vl.id]);
check("approval spends the two days", (await selectOne("SELECT status FROM leave_conversions WHERE id = ?", [conv.id])).status === "approved"
  && Number(vlAfter.used_days) === Number(vl.used_days) + 2 && Number(vlAfter.pending_days) === Number(vl.pending_days));

// ---- 5. retirement fund
r = await maria.get("/my/retirement");
check("My Retirement Fund opens, not enrolled yet", r.status === 200 && r.text.includes("Not enrolled"));
r = await maria.submit("/my/retirement", "/my/retirement/enroll", { rate_percent: "12" });
check("only 10, 15 or 20 percent", !(await selectOne("SELECT id FROM retirement_enrollments WHERE employee_id = ?", [M.id])));
await maria.submit("/my/retirement", "/my/retirement/enroll", { rate_percent: "10" });
await maria.submit("/my/retirement", "/my/retirement/enroll", { rate_percent: "15" });
const enr = await select("SELECT rate_percent, status, active_flag FROM retirement_enrollments WHERE employee_id = ? ORDER BY id", [M.id]);
check("enrolled at 10%, then changed to 15%", enr.length === 2 && enr[0].status === "changed" && enr[1].rate_percent === 15 && enr[1].active_flag === 1, JSON.stringify(enr));
r = await maria.submit("/my/retirement", "/my/retirement/withdrawals", { reason: "voluntary", confirm: "1" });
check("nothing to withdraw before a finalized payroll", !(await selectOne("SELECT id FROM retirement_withdrawals WHERE employee_id = ?", [M.id])));

// a payroll for Payroll/Accounting: Maria's 15% is deducted, the company adds the same, the conversion is paid
const { insertId: periodId } = await exec("INSERT INTO payroll_periods (code, label, start_date, end_date, pay_date, pay_frequency, status) VALUES ('T-RET', 'Retirement test period', '2027-02-01', '2027-02-15', '2027-02-20', 'semi_monthly', 'open')");
const deptId = (await selectOne("SELECT id FROM departments WHERE code = 'PAYROLL_ACCOUNTING'")).id;
// a period for the Payroll/Accounting department only, as a special period would be
await exec("UPDATE payroll_periods SET cutoff = 'special', department_id = ?, scope_key = ? WHERE id = ?", [deptId, `d:${deptId}`, periodId]);
for (let d = new Date("2027-02-01T00:00:00"); d <= new Date("2027-02-15T00:00:00"); d.setDate(d.getDate() + 1)) {
  if (d.getDay() === 0 || d.getDay() === 6) continue; // the default days off (HR has not plotted February)
  await exec(`INSERT INTO attendance_records (employee_id, work_date, time_in, time_out, status, hours_worked, validation_status, source) VALUES (?, ?, '08:00', '17:00', 'present', 8, 'validated', 'punch')`, [M.id, iso(d)]);
}
const dept = await selectOne("SELECT id FROM departments WHERE code = 'PAYROLL_ACCOUNTING'");
r = await paolo.submit("/payroll", `/payroll/periods/${periodId}/compute`, {});
const batch = await selectOne("SELECT * FROM payroll_batches WHERE period_id = ?", [periodId]);
check("payroll computed for the period", r.status === 302 && !!batch, errText(r));
const rec = await selectOne("SELECT * FROM payroll_records WHERE batch_id = ? AND employee_id = ?", [batch?.id, M.id]);
const ded = await selectOne("SELECT d.amount FROM payroll_deductions d JOIN salary_components c ON c.id = d.component_id WHERE d.record_id = ? AND c.code = 'RETIREMENT'", [rec?.id]);
// 560 a day × 261 ÷ 12 = 12,180 a month × 15% = 1,827 ÷ 2 paydays = 913.50
check("15% of the monthly-equivalent basic salary is deducted every payday", ded?.amount === "913.50" && rec.retirement_company_share === "913.50", JSON.stringify({ ded, share: rec?.retirement_company_share }));
const conEarn = await selectOne("SELECT e.amount FROM payroll_earnings e JOIN salary_components c ON c.id = e.component_id WHERE e.record_id = ? AND c.code = 'LEAVE_CONV'", [rec?.id]);
check("the approved vacation leave conversion is paid as an earning", conEarn?.amount === "1120.00");
let t = await paolo.csrf(`/payroll/batches/${batch.id}`);
await paolo.post(`/payroll/batches/${batch.id}/submit`, { _csrf: t });
t = await grace.csrf(`/payroll/batches/${batch.id}`);
await grace.post(`/payroll/batches/${batch.id}/approve`, { _csrf: t, remarks: "OK", acknowledge_own: "1" });
await grace.post(`/payroll/batches/${batch.id}/finalize`, { _csrf: t });
check("the batch is finalized", (await selectOne("SELECT status FROM payroll_batches WHERE id = ?", [batch.id])).status === "finalized", errText(await grace.get(`/payroll/batches/${batch.id}`)));
const contrib = await selectOne("SELECT * FROM retirement_contributions WHERE payroll_record_id = ?", [rec.id]);
check("the contribution is in Maria's fund: her share and the company's", contrib?.employee_share === "913.50" && contrib.company_share === "913.50" && contrib.rate_percent === 15);
check("the conversion is marked paid", (await selectOne("SELECT status, payroll_record_id FROM leave_conversions WHERE id = ?", [conv.id])).payroll_record_id === rec.id);
const acc = await selectOne("SELECT id FROM journal_entries WHERE source_type = 'payroll_batch' AND source_id = ? AND source_event = 'accrual'", [batch.id]);
const accLines = Object.fromEntries((await select("SELECT a.code, l.debit, l.credit FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = ?", [acc.id])).map((l) => [l.code, Number(l.debit) || -Number(l.credit)]));
check("the accrual books the company share as an expense and both shares as a liability", accLines["5060"] >= 913.5 && accLines["2250"] <= -1827, JSON.stringify(accLines));

r = await maria.get("/my/retirement");
check("Maria sees ₱1,827.00 in her fund and that only her ₱913.50 can be withdrawn", r.text.includes("1,827.00") && r.text.includes("913.50"));
r = await maria.submit("/my/retirement", "/my/retirement/withdrawals", { reason: "retirement", confirm: "1" });
check("retirement before 25 years is refused", !(await selectOne("SELECT id FROM retirement_withdrawals WHERE employee_id = ?", [M.id])));
r = await maria.submit("/my/retirement", "/my/retirement/withdrawals", { reason: "voluntary", remarks: "Home repair" });
check("the confirmation box is required", !(await selectOne("SELECT id FROM retirement_withdrawals WHERE employee_id = ?", [M.id])));
r = await maria.submit("/my/retirement", "/my/retirement/withdrawals", { reason: "voluntary", remarks: "Home repair", confirm: "1" });
const w = await selectOne("SELECT * FROM retirement_withdrawals WHERE employee_id = ?", [M.id]);
check("a voluntary withdrawal before vesting: employee share payable, company share forfeited", w && w.payable_amount === "913.50" && w.forfeited_amount === "913.50" && w.vested === 0, JSON.stringify(w));
r = await paolo.submit("/payroll/retirement", `/payroll/retirement/withdrawals/${w.id}/decision`, { action: "approve" });
check("Payroll Staff approve the withdrawal (staff decide employees' requests)", r.status === 302);
const wAfter = await selectOne("SELECT * FROM retirement_withdrawals WHERE id = ?", [w.id]);
const wJe = await selectOne("SELECT id, total_debit FROM journal_entries WHERE source_type = 'retirement_withdrawal' AND source_id = ? AND source_event = 'approval'", [w.id]);
check("approved: the fund is emptied and the enrollment ends", wAfter.status === "approved" && !(await selectOne("SELECT id FROM retirement_enrollments WHERE employee_id = ? AND active_flag = 1", [M.id]))
  && Number((await selectOne("SELECT COUNT(*) n FROM retirement_contributions WHERE employee_id = ? AND withdrawal_id IS NULL", [M.id])).n) === 0);
check("the approval journal releases 1,827.00 (913.50 payable, 913.50 forfeited)", wJe?.total_debit === "1827.00");
r = await paolo.submit("/payroll/retirement", `/payroll/retirement/withdrawals/${w.id}/paid`, { reference: "" });
check("a payout needs a reference", (await selectOne("SELECT status FROM retirement_withdrawals WHERE id = ?", [w.id])).status === "approved");
r = await paolo.submit("/payroll/retirement", `/payroll/retirement/withdrawals/${w.id}/paid`, { reference: "CHK-000123" });
check("Payroll Staff record the payout", (await selectOne("SELECT status, payment_reference FROM retirement_withdrawals WHERE id = ?", [w.id])).payment_reference === "CHK-000123"
  && !!(await selectOne("SELECT id FROM journal_entries WHERE source_type = 'retirement_withdrawal' AND source_id = ? AND source_event = 'payout'", [w.id])));
r = await maria.get(`/my/payslips`);
check("pages render for everyone", (await grace.get("/payroll/retirement")).status === 200 && (await paolo.get("/payroll/retirement")).status === 200 && r.status === 200);

await sequelize.close();
report();
