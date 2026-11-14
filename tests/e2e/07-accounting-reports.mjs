// Phases 7–8 end-to-end: accounting, statements, reports, exports, analytics. Runs after smoke 3–6.
import { Client, check, report, db, errText } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, exec, sequelize } = db;
const maria = new Client(base), paolo = new Client(base), grace = new Client(base), admin = new Client(base), carla = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await paolo.login("paolo@johnvivz.local", "Welcome2026ok");
await grace.login("grace@johnvivz.local", "Welcome2026ok");
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
await carla.login("carla@johnvivz.local", "Welcome2026ok");
const cat = async (n) => (await selectOne("SELECT id FROM transaction_categories WHERE name=?", [n])).id;
const je = async (no) => { const t = await selectOne("SELECT * FROM accounting_transactions WHERE txn_no=?", [no]); const lines = await select("SELECT a.code, l.debit, l.credit FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id=l.account_id WHERE l.entry_id=?", [t.journal_entry_id]); return { t, lines: Object.fromEntries(lines.map((l) => [l.code, Number(l.debit) || -Number(l.credit)])) }; };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

// ---- access
let r = await maria.get("/accounting/income"); check("employee blocked from accounting (403)", r.status === 403);
r = await paolo.get("/accounting/expenses"); check("payroll staff cannot record expenses (403)", r.status === 403);
r = await paolo.get("/accounting/journals"); check("payroll staff cannot view journals (403)", r.status === 403);
r = await carla.get("/accounting/expenses"); check("accounting staff can prepare expenses", r.status === 200 && r.text.includes("goes to the Accounting Supervisor"));
r = await admin.get("/dashboard"); check("admin nav has accounting + reports + analytics", ['href="/accounting/income"', 'href="/reports"', 'href="/analytics"'].every((h) => r.text.includes(h)));

// ---- income & expenses
let t = await admin.csrf("/accounting/income");
r = await admin.multipart("/accounting/income", { _csrf: t, category_id: await cat("Sales Revenue"), txn_date: "2026-10-20", amount: "abc", payment_method: "cash", description: "Bad" });
check("invalid amount rejected", r.status === 422);
r = await admin.multipart("/accounting/income", { _csrf: t, category_id: await cat("Sales Revenue"), txn_date: "2026-10-20", amount: "50000", payment_method: "cash", description: "October sales" });
check("income recorded", r.status === 302, errText(r));
let inc = await selectOne("SELECT txn_no FROM accounting_transactions WHERE description='October sales'");
let e1 = await je(inc.txn_no);
check("income posted Dr cash / Cr sales", e1.t.status === "posted" && e1.lines["1010"] === 50000 && e1.lines["4010"] === -50000, JSON.stringify(e1.lines));
t = await admin.csrf("/accounting/expenses");
r = await admin.multipart("/accounting/expenses", { _csrf: t, category_id: await cat("Rent"), txn_date: "2026-10-05", amount: "12000", payment_method: "bank_transfer", description: "October rent", reference_no: "OR-77" }, { bytes: PNG, type: "image/png", name: "receipt.png" });
check("expense with receipt recorded", r.status === 302, errText(r));
const rent = await selectOne("SELECT * FROM accounting_transactions WHERE description='October rent'");
e1 = await je(rent.txn_no);
check("expense posted Dr rent / Cr bank", e1.lines["5110"] === 12000 && e1.lines["1020"] === -12000 && !!rent.attachment_id);
r = await admin.get(`/documents/${rent.attachment_id}`); check("admin opens receipt", r.status === 200);
r = await maria.get(`/documents/${rent.attachment_id}`); check("employee blocked from receipt (403)", r.status === 403);
r = await admin.multipart("/accounting/expenses", { _csrf: t, category_id: await cat("Supplies"), txn_date: "2026-10-08", amount: "3000", payment_method: "credit", description: "Supplies on account" });
e1 = await je((await selectOne("SELECT txn_no FROM accounting_transactions WHERE description='Supplies on account'")).txn_no);
check("credit expense goes to accounts payable", e1.lines["5130"] === 3000 && e1.lines["2010"] === -3000);

// ---- staff-prepared entry & approval
t = await carla.csrf("/accounting/expenses");
r = await carla.multipart("/accounting/expenses", { _csrf: t, category_id: await cat("Utilities"), txn_date: "2026-10-10", amount: "4500", payment_method: "cash", description: "Electric bill" });
check("staff entry submitted", r.status === 302, errText(r));
let pending = await selectOne("SELECT * FROM accounting_transactions WHERE description='Electric bill'");
check("staff entry is pending, no journal yet", pending.status === "pending_approval" && !pending.journal_entry_id);
r = await admin.get("/accounting/approvals"); check("admin sees approval queue", r.text.includes("Electric bill"));
r = await carla.get("/accounting/approvals"); check("staff blocked from approvals (403)", r.status === 403);
await admin.post(`/accounting/approvals/${pending.id}/decision`, { _csrf: await admin.csrf("/accounting/approvals"), action: "approve" });
pending = await selectOne("SELECT * FROM accounting_transactions WHERE id=?", [pending.id]);
check("approved entry posted", pending.status === "posted" && !!pending.journal_entry_id);
r = await carla.get("/notifications"); check("staff notified of decision", r.text.includes("Accounting entry approved"));
await carla.multipart("/accounting/expenses", { _csrf: await carla.csrf("/accounting/expenses"), category_id: await cat("Supplies"), txn_date: "2026-10-11", amount: "100", payment_method: "cash", description: "Bad entry" });
const bad = await selectOne("SELECT id FROM accounting_transactions WHERE description='Bad entry'");
await admin.post(`/accounting/approvals/${bad.id}/decision`, { _csrf: await admin.csrf("/accounting/approvals"), action: "reject", remarks: "No receipt" });
const badAfter = await selectOne("SELECT status, decision_remarks, amount FROM accounting_transactions WHERE id=?", [bad.id]);
check("rejected entry keeps its details and reason", badAfter.status === "rejected" && badAfter.decision_remarks === "No receipt" && badAfter.amount === "100.00");

// ---- void
t = await admin.csrf("/accounting/expenses");
await admin.multipart("/accounting/expenses", { _csrf: t, category_id: await cat("Supplies"), txn_date: "2026-10-12", amount: "999", payment_method: "cash", description: "Entered by mistake" });
const mistake = await selectOne("SELECT * FROM accounting_transactions WHERE description='Entered by mistake'");
r = await carla.post(`/accounting/expenses/${mistake.id}/void`, { _csrf: await carla.csrf("/accounting/expenses"), reason: "x" }); check("staff cannot void (403)", r.status === 403);
await admin.post(`/accounting/expenses/${mistake.id}/void`, { _csrf: t, reason: "" });
check("void needs a reason", (await selectOne("SELECT status FROM accounting_transactions WHERE id=?", [mistake.id])).status === "posted");
await admin.post(`/accounting/expenses/${mistake.id}/void`, { _csrf: t, reason: "Duplicate entry" });
check("voided with reversal", (await selectOne("SELECT status FROM accounting_transactions WHERE id=?", [mistake.id])).status === "voided" && (await selectOne("SELECT status FROM journal_entries WHERE id=?", [mistake.journal_entry_id])).status === "reversed");
const tamper = await exec("UPDATE accounting_transactions SET amount=1 WHERE id=?", [rent.id]).then(() => "ok", (e) => e.message);
check("database refuses editing posted amounts", tamper !== "ok");

// ---- adjustments
const acct = async (c) => (await selectOne("SELECT id FROM chart_of_accounts WHERE code=?", [c])).id;
t = await carla.csrf("/accounting/adjustments");
r = await carla.post("/accounting/adjustments", { _csrf: t, txn_date: "2026-10-30", description: "Owner capital correction", lines: { l0: { account_id: await acct("1010"), debit: "1000" }, l1: { account_id: await acct("3010"), credit: "999" } } });
check("unbalanced adjustment refused", r.status === 400 && r.text.includes("must equal credits"), errText(r));
r = await carla.post("/accounting/adjustments", { _csrf: t, txn_date: "2026-10-30", description: "Owner capital contribution", lines: { l0: { account_id: await acct("1010"), debit: "100000" }, l1: { account_id: await acct("3010"), credit: "100000" } } });
check("balanced adjustment submitted", r.status === 302, errText(r));
const adj = await selectOne("SELECT * FROM accounting_transactions WHERE txn_type='adjustment'");
check("adjustment waits as draft journal", adj.status === "pending_approval" && (await selectOne("SELECT status FROM journal_entries WHERE id=?", [adj.journal_entry_id])).status === "draft");
await admin.post(`/accounting/approvals/${adj.id}/decision`, { _csrf: await admin.csrf("/accounting/approvals"), action: "approve" });
check("adjustment posted after approval", (await selectOne("SELECT status FROM journal_entries WHERE id=?", [adj.journal_entry_id])).status === "posted");
t = await admin.csrf("/accounting/adjustments");
await admin.post("/accounting/adjustments", { _csrf: t, txn_date: "2026-10-30", description: "Admin own adjustment", lines: { l0: { account_id: await acct("1010"), debit: "5" }, l1: { account_id: await acct("3010"), credit: "5" } } });
const own = await selectOne("SELECT id FROM accounting_transactions WHERE description='Admin own adjustment'");
r = await admin.post(`/accounting/approvals/${own.id}/decision`, { _csrf: await admin.csrf("/accounting/approvals"), action: "approve" });
check("cannot approve own adjustment (403)", r.status === 403);
await carla.get("/dashboard");
await exec("UPDATE accounting_transactions SET status='rejected', decision_remarks='test cleanup' WHERE id=?", [own.id]);

// ---- periods
r = await admin.get("/accounting/periods"); check("financial periods listed", r.text.includes("October 2026"));
const oct = await selectOne("SELECT id FROM financial_periods WHERE label='October 2026'");
t = await admin.csrf("/accounting/periods");
await admin.post(`/accounting/periods/${oct.id}/close`, { _csrf: t });
check("period closed", (await selectOne("SELECT status FROM financial_periods WHERE id=?", [oct.id])).status === "closed");
t = await admin.csrf("/accounting/income");
r = await admin.multipart("/accounting/income", { _csrf: t, category_id: await cat("Other Income"), txn_date: "2026-10-25", amount: "10", payment_method: "cash", description: "Into closed month" });
check("posting into a closed month refused", r.status === 400 && r.text.includes("closed"), errText(r));
await admin.post(`/accounting/periods/${oct.id}/reopen`, { _csrf: await admin.csrf("/accounting/periods") });

// ---- real payroll for October feeds the statements
const period = await selectOne("SELECT * FROM payroll_periods WHERE start_date='2026-10-01'");
// the period's one run (left as a draft by stage 06) is recomputed from the Payroll tab
r = await paolo.post(`/payroll/periods/${period.id}/compute`, { _csrf: await paolo.csrf("/payroll") });
const bid = Number(r.loc.split("/").pop());
await paolo.post(`/payroll/batches/${bid}/submit`, { _csrf: await paolo.csrf(`/payroll/batches/${bid}`) });
t = await grace.csrf(`/payroll/batches/${bid}`);
await grace.post(`/payroll/batches/${bid}/approve`, { _csrf: t, acknowledge_own: "1" });
await grace.post(`/payroll/batches/${bid}/finalize`, { _csrf: t });
await grace.post(`/payroll/batches/${bid}/release`, { _csrf: t });
check("October payroll released", (await selectOne("SELECT status FROM payroll_batches WHERE id=?", [bid])).status === "released");

// ---- statements
const Q = "from=2026-10-01&to=2026-11-30";
r = await admin.get(`/reports/income-statement?${Q}`);
check("income statement: revenue and net income", r.status === 200 && r.text.includes("₱50,000.00") && /Net (income|loss)/.test(r.text), errText(r));
// revenue 50,000 − (salaries 25,880 + OT 175 + benefits 3,492.58 + COGS 0 + rent 12,000 + utilities 4,500 + supplies 3,000) = 952.42
check("income statement net income is exact", r.text.includes("₱952.42"), "expected 952.42");
r = await admin.get("/reports/balance-sheet?asOf=2026-11-30");
check("balance sheet balances", r.status === 200 && !r.text.includes("do not equal"), errText(r));
r = await admin.get("/reports/trial-balance?asOf=2026-11-30");
check("trial balance agrees", r.status === 200 && !r.text.includes("do not equal"));
const tb = await selectOne("SELECT SUM(l.debit) d, SUM(l.credit) c FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.entry_id WHERE j.status IN ('posted','reversed')");
check("ledger debits equal credits overall", tb.d === tb.c, JSON.stringify(tb));
const accountId = await acct("1010");
r = await admin.get(`/reports/general-ledger?${Q}&account=${accountId}`); check("general ledger with running balance", r.text.includes("Opening balance") && r.text.includes("Period totals"));
r = await admin.get(`/reports/cash-flow?${Q}`);
const cash = await selectOne("SELECT SUM(l.debit-l.credit) n FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.entry_id JOIN chart_of_accounts a ON a.id=l.account_id WHERE a.is_cash=1 AND j.status IN ('posted','reversed') AND j.entry_date<='2026-11-30'");
const fmt = "₱" + Number(cash.n).toLocaleString("en-PH", { minimumFractionDigits: 2 });
check("cash flow closing cash matches the ledger", r.text.includes(fmt) && r.text.includes("Salaries and wages paid"), fmt);

// ---- every report renders and exports, permission enforced
const fin = ["expense-report", "income-report", "income-statement", "balance-sheet", "cash-flow", "trial-balance", "general-ledger", "financial-analytics"];
const hr = ["employee-masterlist", "payroll-register", "monthly-payroll", "payroll-expense", "employee-compensation", "deduction-summary", "attendance-summary", "daily-time-records", "overtime-summary", "leave-summary", "bank-enrollment-summary"];
for (const k of [...fin, ...hr]) {
  const who = fin.includes(k) ? admin : grace;
  const q = k === "daily-time-records" ? `?employee=1&from=2026-10-01&to=2026-10-31` : `?from=2026-10-01&to=2026-11-30&year=2026`;
  const a = await who.get(`/reports/${k}${q}`);
  const p = await who.get(`/reports/${k}/export${q}&format=pdf`);
  const x = await who.get(`/reports/${k}/export${q}&format=xlsx`);
  check(`report ${k}: page, PDF, Excel`, a.status === 200 && p.buf.subarray(0, 5).toString() === "%PDF-" && x.buf.subarray(0, 2).toString() === "PK", `${a.status} ${p.status} ${x.status} ${errText(a)}`);
}
r = await paolo.get("/reports/balance-sheet"); check("payroll staff blocked from financial statements (403)", r.status === 403);
r = await maria.get("/reports"); check("employee blocked from reports (403)", r.status === 403);
r = await maria.get("/reports/payroll-register"); check("employee blocked from payroll register (403)", r.status === 403);
r = await paolo.get("/reports"); check("payroll staff catalog hides financial reports", r.text.includes("Payroll Register") && !r.text.includes("Balance Sheet"));
r = await grace.get(`/reports/payroll-register?period=${period.id}`); check("payroll register totals", r.text.includes("₱22,859.92") && r.text.includes("Maria Santos Dela Cruz"));
r = await grace.get("/reports/bank-enrollment-summary"); check("bank report masks accounts", r.text.includes("••••4455") && !r.text.includes("001122334455"));
r = await grace.get("/reports/employee-masterlist"); check("masterlist has no government IDs", !r.text.includes("34-1234567-8"));
check("exports are audited", !!(await selectOne("SELECT id FROM audit_logs WHERE action='report_exported' LIMIT 1")));

// ---- analytics
r = await admin.get("/analytics?from=2026-06&to=2026-11");
check("analytics page renders for admin", r.status === 200 && r.text.includes("Payroll cost") && r.text.includes("Revenue vs expenses"), errText(r));
// only the batch that went through the real workflow: earlier tests insert some payslip rows directly, with no journals
const realBatch = await selectOne("SELECT b.id, b.period_id, p.start_date, p.end_date FROM payroll_batches b JOIN payroll_periods p ON p.id = b.period_id WHERE b.status = 'released' ORDER BY b.id DESC LIMIT 1");
const books = await selectOne("SELECT COALESCE(SUM(l.debit - l.credit), 0) AS n FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.code IN ('5010', '5020', '5030') AND j.source_type = 'payroll_batch' AND j.source_id = ?", [realBatch.id]);
const bookAmount = "₱" + Number(books.n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const periodView = await admin.get(`/analytics?period=${realBatch.period_id}`);
check("analytics payroll cost equals the payroll expense in the journals", Number(books.n) > 0 && periodView.text.includes(bookAmount), bookAmount);
const expenseReport = await admin.get(`/reports/payroll-expense?from=${realBatch.start_date}&to=${realBatch.end_date}`);
check("payroll expense report equals the journals too", expenseReport.text.includes(bookAmount), bookAmount);
r = await paolo.get("/analytics"); check("payroll staff analytics hides financial charts", r.status === 200 && r.text.includes("Monthly payroll expense") && !r.text.includes("Revenue vs expenses"));
r = await maria.get("/analytics"); check("employee blocked from analytics (403)", r.status === 403);
r = await admin.get(`/analytics?department=1&employee=1&period=${period.id}`); check("analytics filters work", r.status === 200);
check("forecast needs 3 months of history", (await admin.get("/analytics")).text.includes("Not enough history"));
report();
await sequelize.close();
