// Phase 6 end-to-end: a full payroll run through the real screens, expected figures calculated by hand.
import { Client, check, report, db, errText } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, exec, sequelize } = db;
// The figures below were worked out by hand for a company on a six-day week (Sunday off, 313 days a year), which the
// settings still support; stage 19 runs payroll on the five-day week with two days off.
await exec("UPDATE system_settings SET setting_value = '313' WHERE setting_key = 'payroll.days_per_year'");
await exec("UPDATE system_settings SET setting_value = '' WHERE setting_key = 'attendance.rest_day_2'");
const maria = new Client(base), paolo = new Client(base), grace = new Client(base), admin = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await paolo.login("paolo@johnvivz.local", "Welcome2026ok");
await grace.login("grace@johnvivz.local", "Welcome2026ok");
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
const emp = (no) => selectOne("SELECT * FROM employees WHERE employee_no = ?", [no]);
const M = await emp("JV-0001"), P = await emp("JV-0002"), G = await emp("JV-0003");
const je = (id, ev) => selectOne("SELECT * FROM journal_entries WHERE source_type='payroll_batch' AND source_id=? AND source_event=?", [id, ev]);
const lines = async (entry) => Object.fromEntries((await select("SELECT a.code, l.debit, l.credit FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id=l.account_id WHERE l.entry_id=?", [entry.id])).map((l) => [l.code, Number(l.debit) || -Number(l.credit)]));

// ---- access
let r = await paolo.get("/payroll/setup/statutory"); check("staff blocked from statutory setup (403)", r.status === 403);
r = await paolo.get("/payroll/setup/tax"); check("payroll staff blocked from tax setup (403)", r.status === 403);
r = await maria.get("/payroll"); check("employee blocked from payroll (403)", r.status === 403);
r = await paolo.get("/dashboard"); check("staff nav: one Payroll tab, no approvals", r.text.includes('href="/payroll"') && !r.text.includes('href="/payroll/batches"') && !r.text.includes('href="/payroll/pay-items/review"'));

// ---- period: only the supervisor creates them, and semi-monthly ones always take the fixed dates
let t = await paolo.csrf("/payroll");
r = await paolo.post("/payroll/periods/month", { _csrf: t, month: "2026-10" });
check("Payroll Staff cannot create periods (403)", r.status === 403);
t = await grace.csrf("/payroll");
r = await grace.post("/payroll/periods/month", { _csrf: t, month: "2026-10" });
const period = await selectOne("SELECT * FROM payroll_periods WHERE start_date='2026-10-01' AND pay_frequency='semi_monthly'");
const second = await selectOne("SELECT * FROM payroll_periods WHERE start_date='2026-10-16' AND pay_frequency='semi_monthly'");
check("kinsenas Oct 1–15 is paid on the 25th, released Friday the 23rd (the 25th is a Sunday)", r.status === 302 && period?.pay_date === "2026-10-25" && period.release_date === "2026-10-23" && period.end_date === "2026-10-15", JSON.stringify(period));
// (an earlier stage's fixture may already hold Oct 16–31; then the schedule leaves it alone)
check("katapusan Oct 16–31 is paid on 10 November", second?.end_date === "2026-10-31" && (second.code !== "SM-2026-10-16" || second.pay_date === "2026-11-10"), JSON.stringify(second));
r = await grace.post("/payroll/periods/month", { _csrf: t, month: "2026-10" });
check("the same month cannot be created twice", Number((await selectOne("SELECT COUNT(*) n FROM payroll_periods WHERE start_date='2026-10-01'")).n) === 1);
r = await admin.post(`/payroll/periods/${period.id}/compute`, { _csrf: await admin.csrf("/payroll") });
check("the supervisor does not compute payroll (403)", r.status === 403);
// computing a period: the run page on success, back to Payroll with the reason otherwise
const compute = async () => {
  const res = await paolo.post(`/payroll/periods/${period.id}/compute`, { _csrf: await paolo.csrf("/payroll") });
  return res.status === 302 && res.loc === "/payroll" ? { ...res, status: 400, text: (await paolo.get("/payroll")).text } : res;
};

// ---- holiday + attendance (attendance entry itself is covered by the Phase 5 test)
t = await admin.csrf("/payroll/setup/holidays");
r = await admin.post("/payroll/setup/holidays", { _csrf: t, holiday_date: "2026-10-07", name: "Test Regular Holiday", holiday_type: "regular" });
check("holiday added", r.status === 302 && !!(await selectOne("SELECT id FROM holidays WHERE holiday_date='2026-10-07'")));
const days = ["01","02","03","05","06","08","09","10","12","13","14","15"];
for (const e of [M, P, G]) for (const d of days) {
  await exec("INSERT INTO attendance_records (employee_id, work_date, time_in, time_out, status, hours_worked, validation_status, created_by) VALUES (?,?, '08:00:00','17:00:00','present',8,'validated',1)", [e.id, `2026-10-${d}`]);
}

// ---- unverified statutory data blocks computation
r = await compute();
check("computation refused on unverified statutory data", r.status === 400 && r.text.includes("unverified statutory data"), errText(r));
t = await admin.csrf("/payroll/setup/statutory");
for (const rule of await select("SELECT id FROM statutory_contribution_rules")) await admin.post(`/payroll/setup/statutory/${rule.id}/verify`, { _csrf: t });
await admin.post("/payroll/setup/tax/verify", { _csrf: await admin.csrf("/payroll/setup/tax"), effective_from: "2023-01-01" });
check("rules and tax table verified", (await selectOne("SELECT COUNT(*) n FROM statutory_contribution_rules WHERE is_verified=0")).n === 0 && (await selectOne("SELECT COUNT(*) n FROM withholding_tax_brackets WHERE is_verified=0")).n === 0);

// ---- pay items, overtime, adjustment
const comp = async (c) => (await selectOne("SELECT id FROM salary_components WHERE code=?", [c])).id;
t = await paolo.csrf("/payroll/pay-items");
r = await paolo.post("/payroll/pay-items", { _csrf: t, employee_id: M.id, component_id: await comp("ALLOWANCE"), amount: "500", effective_from: "2026-01-01", description: "Meal allowance" });
check("allowance submitted", r.status === 302, errText(r));
r = await paolo.post("/payroll/pay-items", { _csrf: t, employee_id: M.id, component_id: await comp("LOAN"), amount: "1000", effective_from: "2026-01-01", description: "Salary advance" });
check("loan without total refused", r.status === 400 && r.text.includes("total loan"));
r = await paolo.post("/payroll/pay-items", { _csrf: t, employee_id: M.id, component_id: await comp("LOAN"), amount: "1000", remaining_balance: "1500", effective_from: "2026-01-01", description: "Salary advance" });
check("loan submitted", r.status === 302);
r = await paolo.post("/payroll/pay-items", { _csrf: t, employee_id: P.id, component_id: await comp("ALLOWANCE"), amount: "999", effective_from: "2026-01-01" });
check("staff cannot encode own pay item", r.status === 403);
r = await grace.get("/payroll/pay-items/review"); check("supervisor sees pay items", r.text.includes("Meal allowance") && r.text.includes("Salary advance"));
t = await grace.csrf("/payroll/pay-items/review");
for (const i of await select("SELECT id FROM employee_pay_items")) await grace.post(`/payroll/pay-items/${i.id}/decision`, { _csrf: t, action: "approve" });
check("pay items approved", (await selectOne("SELECT COUNT(*) n FROM employee_pay_items WHERE status='approved'")).n === 2);
t = await paolo.csrf("/overtime");
r = await paolo.post("/overtime", { _csrf: t, employee_id: M.id, work_date: "2026-10-06", hours: "2", ot_type: "regular", reason: "Stock count" });
check("overtime encoded", r.status === 302, errText(r));
const ot = await selectOne("SELECT id FROM overtime_records WHERE work_date='2026-10-06'");
await grace.post(`/overtime/${ot.id}/decision`, { _csrf: await grace.csrf("/overtime/review"), action: "approve" });
t = await paolo.csrf("/payroll/adjustments");
r = await paolo.post("/payroll/adjustments", { _csrf: t, employee_id: M.id, period_id: period.id, component_id: await comp("OTHER_EARN"), amount: "100", reason: "Underpaid in September" });
check("adjustment filed", r.status === 302, errText(r));
const adj = await selectOne("SELECT id FROM payroll_adjustments");
r = await grace.post(`/payroll/adjustments/${adj.id}/decision`, { _csrf: await grace.csrf("/payroll/adjustments/review"), action: "reject", remarks: "" });
check("adjustment reject needs a reason", (await selectOne("SELECT status FROM payroll_adjustments WHERE id=?", [adj.id])).status === "pending");
await grace.post(`/payroll/adjustments/${adj.id}/decision`, { _csrf: await grace.csrf("/payroll/adjustments/review"), action: "approve" });

// the raise recorded in the Phase 3 test took effect "today"; back-date it so it applies to this October period
await exec("UPDATE salary_history SET effective_date='2026-09-01' WHERE employee_id=? AND previous_amount IS NOT NULL", [M.id]);
// ---- batch computation (hand-calculated)
r = await compute();
check("batch computed", r.status === 302 && /batches\/\d+/.test(r.loc || ""), errText(r));
const bid = Number(r.loc.split("/").pop());
let b = await selectOne("SELECT * FROM payroll_batches WHERE id=?", [bid]);
const mr = await selectOne("SELECT * FROM payroll_records WHERE batch_id=? AND employee_id=?", [bid, M.id]);
check("Maria basic 12 days × 560", mr.basic_pay === "6720.00", mr.basic_pay);
check("Maria unworked regular holiday paid", mr.holiday_pay === "560.00", mr.holiday_pay);
check("Maria overtime 2h × 70 × 1.25", mr.overtime_pay === "175.00", mr.overtime_pay);
check("Maria allowance and adjustment", mr.allowances === "500.00" && mr.other_earnings === "100.00");
check("Maria gross 8,055.00", mr.gross_pay === "8055.00", mr.gross_pay);
check("Maria employee contributions 645.08", mr.statutory_employee === "645.08", mr.statutory_employee);
check("Maria loan deduction 1,000", mr.other_deductions === "1000.00", mr.other_deductions);
check("Maria net 6,409.92", mr.net_pay === "6409.92", mr.net_pay);
check("Maria employer share 1,012.58", mr.employer_contributions === "1012.58", mr.employer_contributions);
const pr = await selectOne("SELECT * FROM payroll_records WHERE batch_id=? AND employee_id=?", [bid, P.id]);
check("Paolo monthly-rated net 8,225.00", pr.net_pay === "8225.00" && pr.holiday_pay === "0.00", pr.net_pay);
check("batch totals", b.employee_count === 3 && b.total_gross === "26055.00" && b.total_net === "22859.92" && b.total_employer_contributions === "3492.58" && b.total_deductions === "3195.08", JSON.stringify(b));
r = await paolo.get(`/payroll/records/${mr.id}`); check("record breakdown page", r.status === 200 && r.text.includes("Meal allowance") && r.text.includes("Rates: monthly-equivalent"));
r = await compute();
check("computing the period again recomputes its one run", r.status === 302 && r.loc === `/payroll/batches/${bid}` && Number((await selectOne("SELECT COUNT(*) n FROM payroll_batches WHERE period_id = ?", [period.id])).n) === 1, r.loc);

// ---- submit / salary verification gate
t = await paolo.csrf(`/payroll/batches/${bid}`);
r = await paolo.post(`/payroll/batches/${bid}/submit`, { _csrf: t }); r = await paolo.get(`/payroll/batches/${bid}`);
check("submit blocked by unverified salary change", r.text.includes("await supervisor verification"), errText(r));
const sh = await selectOne("SELECT id FROM salary_history WHERE employee_id=? AND verification_status='pending'", [M.id]);
r = await grace.get("/payroll/salary-changes"); check("supervisor sees salary change", r.text.includes("Maria Santos Dela Cruz") && r.text.includes("Annual increase"));
await grace.post(`/payroll/salary-changes/${sh.id}/decision`, { _csrf: await grace.csrf("/payroll/salary-changes"), action: "approve" });
t = await paolo.csrf(`/payroll/batches/${bid}`);
r = await paolo.post(`/payroll/batches/${bid}/submit`, { _csrf: t });
b = await selectOne("SELECT * FROM payroll_batches WHERE id=?", [bid]);
check("batch submitted", b.status === "for_review");
r = await paolo.post(`/payroll/batches/${bid}/approve`, { _csrf: t }); check("staff cannot approve (403)", r.status === 403);
r = await grace.get("/notifications"); check("supervisor notified of submission", r.text.includes("Payroll batch awaiting approval"));

// ---- reject then resubmit
t = await grace.csrf(`/payroll/batches/${bid}`);
await grace.post(`/payroll/batches/${bid}/reject`, { _csrf: t, reason: "" });
check("reject needs a reason", (await selectOne("SELECT status FROM payroll_batches WHERE id=?", [bid])).status === "for_review");
await grace.post(`/payroll/batches/${bid}/reject`, { _csrf: t, reason: "Please recheck overtime" });
b = await selectOne("SELECT * FROM payroll_batches WHERE id=?", [bid]);
check("rejected batch returns to draft with reason", b.status === "draft" && b.last_rejection_reason === "Please recheck overtime");
t = await paolo.csrf(`/payroll/batches/${bid}`);
await paolo.post(`/payroll/batches/${bid}/recompute`, { _csrf: t });
check("recompute keeps the same totals", (await selectOne("SELECT total_net FROM payroll_batches WHERE id=?", [bid])).total_net === "22859.92");
await paolo.post(`/payroll/batches/${bid}/submit`, { _csrf: t });

// ---- approval with the supervisor's own pay in the batch
t = await grace.csrf(`/payroll/batches/${bid}`);
r = await grace.get(`/payroll/batches/${bid}`); check("own-pay acknowledgement is shown", r.text.includes("my own pay"));
await grace.post(`/payroll/batches/${bid}/approve`, { _csrf: t, remarks: "OK" });
check("approval without own-pay acknowledgement refused", (await selectOne("SELECT status FROM payroll_batches WHERE id=?", [bid])).status === "for_review");
await grace.post(`/payroll/batches/${bid}/approve`, { _csrf: t, remarks: "OK", acknowledge_own: "1" });
b = await selectOne("SELECT * FROM payroll_batches WHERE id=?", [bid]);
check("approved with acknowledgement", b.status === "approved");
const flagged = await selectOne("SELECT new_value, remarks FROM audit_logs WHERE action='payroll_batch_approved' ORDER BY id DESC");
check("own-pay approval flagged in audit log", JSON.stringify(flagged.new_value).includes("approver_own_record") && /own payroll record/.test(flagged.remarks));
await paolo.post(`/payroll/batches/${bid}/finalize`, { _csrf: await paolo.csrf(`/payroll/batches/${bid}`) });
check("staff cannot finalize", (await selectOne("SELECT status FROM payroll_batches WHERE id=?", [bid])).status === "approved");

// ---- finalize
await grace.post(`/payroll/batches/${bid}/finalize`, { _csrf: t });
b = await selectOne("SELECT * FROM payroll_batches WHERE id=?", [bid]);
check("finalized", b.status === "finalized", errText(await grace.get(`/payroll/batches/${bid}`)));
const acc = await je(bid, "accrual");
const al = await lines(acc);
check("accrual journal posted and balanced", acc.status === "posted" && acc.total_debit === "29547.58" && acc.total_credit === "29547.58", JSON.stringify(acc));
check("accrual accounts", al["5010"] === 25880 && al["5020"] === 175 && al["5030"] === 3492.58 && al["2100"] === -22859.92 && al["2210"] === -3822.5 && al["2220"] === -1265.16 && al["2230"] === -600 && al["1100"] === -1000, JSON.stringify(al));
const att = await selectOne("SELECT COUNT(*) n FROM attendance_records WHERE locked_batch_id=? AND validation_status='locked'", [bid]);
check("attendance locked", att.n === 36, att.n);
check("overtime linked to the record", !!(await selectOne("SELECT payroll_record_id FROM overtime_records WHERE id=?", [ot.id])).payroll_record_id);
check("loan balance reduced to 500", (await selectOne("SELECT remaining_balance FROM employee_pay_items WHERE remaining_balance IS NOT NULL")).remaining_balance === "500.00");
check("adjustment applied", (await selectOne("SELECT status FROM payroll_adjustments WHERE id=?", [adj.id])).status === "applied");
check("payslips generated, not released", (await selectOne("SELECT COUNT(*) n FROM payslips s JOIN payroll_records r ON r.id=s.record_id WHERE r.batch_id=? AND s.status='generated'", [bid])).n === 3);
r = await maria.get("/my/payslips"); check("employee cannot see unreleased payslip", !r.text.includes("Oct 1–15"));
const editAttempt = await exec("UPDATE payroll_records SET status=status WHERE batch_id=?", [bid]).then(() => "ok", (e) => e.message);
check("no-op update tolerated", editAttempt === "ok", editAttempt);
const tamper = await exec("UPDATE payroll_records SET net_pay=1 WHERE batch_id=?", [bid]).then(() => "ok", (e) => e.message);
check("database refuses edits to finalized pay", tamper !== "ok");
t = await maria.csrf("/my/attendance");
r = await maria.multipart("/my/attendance/corrections", { _csrf: t, work_date: "2026-10-06", requested_status: "present", requested_time_in: "08:00", requested_time_out: "17:00", reason: "Trying to change a locked day" });
check("correction on a locked day refused", r.status === 400 && r.text.includes("finalized payroll"), errText(r));

// ---- release
t = await grace.csrf(`/payroll/batches/${bid}`);
await grace.post(`/payroll/batches/${bid}/release`, { _csrf: t });
b = await selectOne("SELECT * FROM payroll_batches WHERE id=?", [bid]);
check("released", b.status === "released");
const dis = await je(bid, "disbursement"), dl = await lines(dis);
check("disbursement splits bank vs cash", dl["2100"] === 22859.92 && dl["1020"] === -6409.92 && dl["1010"] === -16450, JSON.stringify(dl));
r = await maria.get("/my/payslips"); check("released payslip visible with correct net", r.text.includes("₱6,409.92"));
const slip = await selectOne("SELECT id FROM payslips WHERE employee_id=? ORDER BY id DESC", [M.id]);
r = await maria.get(`/my/payslips/${slip.id}/pdf`); check("employee PDF", r.type === "application/pdf" && r.buf.subarray(0, 5).toString() === "%PDF-");
r = await maria.get("/notifications"); check("employee notified", r.text.includes("Your payslip is available"));
r = await paolo.get(`/payroll/payslips/${slip.id}`); check("staff payslip view", r.status === 200 && r.text.includes("₱6,409.92"));
r = await paolo.get("/payroll/payslips"); check("payslip list", r.text.includes("Maria Santos Dela Cruz"));
r = await maria.get(`/payroll/payslips/${slip.id}`); check("employee blocked from all-payslip view (403)", r.status === 403);
r = await maria.get("/dashboard"); check("employee dashboard shows pay", r.text.includes("₱6,409.92"));

// ---- void
await grace.post(`/payroll/batches/${bid}/void`, { _csrf: t, reason: "" });
check("void needs a reason", (await selectOne("SELECT status FROM payroll_batches WHERE id=?", [bid])).status === "released");
await grace.post(`/payroll/batches/${bid}/void`, { _csrf: t, reason: "Wrong rates applied" });
b = await selectOne("SELECT * FROM payroll_batches WHERE id=?", [bid]);
check("voided", b.status === "voided" && b.void_reason === "Wrong rates applied");
check("both journals reversed", (await selectOne("SELECT COUNT(*) n FROM journal_entries WHERE source_type='payroll_batch' AND source_id=? AND status='reversed'", [bid])).n === 2 && (await selectOne("SELECT COUNT(*) n FROM journal_entries WHERE source_type='reversal' AND status='posted'")).n === 2);
const net = await selectOne("SELECT COALESCE(SUM(l.debit-l.credit),0) n FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.entry_id JOIN chart_of_accounts a ON a.id=l.account_id WHERE a.code='2100'");
check("payroll payable nets to zero after reversal", Number(net.n) === 0, net.n);
check("attendance unlocked", (await selectOne("SELECT COUNT(*) n FROM attendance_records WHERE locked_batch_id IS NOT NULL")).n === 0);
check("overtime available again", (await selectOne("SELECT payroll_record_id p FROM overtime_records WHERE id=?", [ot.id])).p === null);
check("loan balance restored", (await selectOne("SELECT remaining_balance b, status FROM employee_pay_items WHERE remaining_balance IS NOT NULL")).b === "1500.00");
check("adjustment back to approved", (await selectOne("SELECT status FROM payroll_adjustments WHERE id=?", [adj.id])).status === "approved");
r = await maria.get(`/my/payslips/${slip.id}`); check("voided payslip hidden from employee", r.status === 404);
r = await compute();
check("period can be re-processed after void", r.status === 302, errText(r));
const b2 = Number(r.loc.split("/").pop());
check("recomputed batch has the same net", (await selectOne("SELECT total_net FROM payroll_batches WHERE id=?", [b2])).total_net === "22859.92");
r = await paolo.get("/payroll");
check("the Payroll tab shows the period, its payday and its run", r.text.includes("Oct 1–15, 2026 (kinsenas)") && r.text.includes("released") && r.text.includes(`/payroll/batches/${b2}`));
const actions = new Set((await select("SELECT action FROM audit_logs WHERE module='payroll'")).map((a) => a.action));
check("audit trail covers every stage", ["payroll_batch_created", "payroll_batch_submitted", "payroll_batch_rejected", "payroll_batch_approved", "payroll_batch_finalized", "payroll_batch_released", "payroll_batch_voided", "salary_change_verified"].every((a) => actions.has(a)), [...actions].join(","));
report();
await sequelize.close();
