import { select, selectOne, scalar } from "../lib/db.js";
import { PAYROLL_EXPENSE_SQL } from "../lib/payrollCost.js";
import { formatPHP } from "../lib/money.js";
import { ensureBalances } from "./leaveService.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Last N calendar months ending with the current one: [{ key: "2026-06", label: "Jun 2026" }, ...]
export function lastMonths(n = 6, from = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(from.getFullYear(), from.getMonth() - i, 1);
    out.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` });
  }
  return out;
}

const fill = (months, rows, field) => {
  const m = new Map(rows.map((r) => [r.ym, Number(r[field])]));
  return months.map((x) => m.get(x.key) ?? 0);
};

// ---- shared building blocks ---------------------------------------------------------------------------------------
async function employeeCounts() {
  return selectOne(
    `SELECT COUNT(*) AS total, COALESCE(SUM(employment_status = 'active'), 0) AS active
       FROM employees WHERE deleted_at IS NULL`
  );
}

// Payroll cost per month = earned pay + employer contributions of finalized/released, non-voided records (matches the journals)
async function payrollTrend(months) {
  const rows = await select(
    `SELECT DATE_FORMAT(p.end_date, '%Y-%m') AS ym,
            SUM(r.gross_pay) AS gross, SUM(r.employer_contributions) AS employer, SUM(r.net_pay) AS net, SUM(${PAYROLL_EXPENSE_SQL}) AS expense
       FROM payroll_records r JOIN payroll_periods p ON p.id = r.period_id
      WHERE r.status IN ('finalized','released') AND r.active_flag = 1
        AND p.end_date >= ? GROUP BY ym`,
    [`${months[0].key}-01`]
  );
  const gross = fill(months, rows, "gross");
  const employer = fill(months, rows, "employer");
  return { gross, employer, cost: fill(months, rows, "expense"), net: fill(months, rows, "net") };
}

// Income / expense from POSTED journals (single source of truth — payroll expense comes in via its own journal)
async function incomeExpenseTrend(months) {
  const rows = await select(
    `SELECT DATE_FORMAT(j.entry_date, '%Y-%m') AS ym, a.account_type,
            SUM(l.debit) AS d, SUM(l.credit) AS c
       FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.entry_id AND j.status IN ('posted','reversed')
       JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE a.account_type IN ('revenue','expense') AND j.entry_date >= ?
      GROUP BY ym, a.account_type`,
    [`${months[0].key}-01`]
  );
  const income = months.map((m) => rows.filter((r) => r.ym === m.key && r.account_type === "revenue").reduce((s, r) => s + Number(r.c) - Number(r.d), 0));
  const expense = months.map((m) => rows.filter((r) => r.ym === m.key && r.account_type === "expense").reduce((s, r) => s + Number(r.d) - Number(r.c), 0));
  return { income, expense };
}

async function attendanceMonth(employeeId = null) {
  const rows = await select(
    `SELECT status, COUNT(*) AS n FROM attendance_records
      WHERE work_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND work_date <= CURDATE()
        ${employeeId ? "AND employee_id = ?" : ""} GROUP BY status`,
    employeeId ? [employeeId] : []
  );
  const get = (s) => Number(rows.find((r) => r.status === s)?.n || 0);
  return [
    { key: "present", name: "Present", value: get("present") },
    { key: "late", name: "Late", value: get("late") },
    { key: "on_leave", name: "On leave", value: get("on_leave") },
    { key: "absent", name: "Absent", value: get("absent") },
  ];
}

const recentAudit = (modules = null, userId = null, limit = 8) => {
  const where = [];
  const params = [];
  if (modules) { where.push(`module IN (${modules.map(() => "?").join(",")})`); params.push(...modules); }
  if (userId) { where.push("user_id = ?"); params.push(userId); }
  // sign-in noise stays in the audit log but is kept out of dashboard activity feeds
  where.push("action NOT IN ('login','logout','login_failed','login_blocked_locked','login_blocked_inactive')");
  return select(
    `SELECT id, user_name, user_role, action, module, record_type, record_id, remarks, created_at
       FROM audit_logs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${Number(limit)}`,
    params
  );
};

const announcements = (audience) =>
  select(
    `SELECT id, title, body, published_at FROM announcements
      WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > NOW()) AND audience IN ('all', ?)
      ORDER BY published_at DESC LIMIT 3`,
    [audience]
  );

const currentPeriod = () =>
  selectOne(
    `SELECT id, code, label, start_date, end_date, pay_date, status FROM payroll_periods
      WHERE status = 'open' ORDER BY (CURDATE() BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`
  );

/** Panels shared by the staff dashboards: this user's approval queues, latest batches, latest notifications. */
export async function dashboardPanels(user) {
  const QUEUES = [
    ["payroll.approve", "Payroll batches", "/payroll/batches?status=for_review", "SELECT COUNT(*) FROM payroll_batches WHERE status = 'for_review'"],
    ["employees.salary.verify", "Salary changes", "/payroll/salary-changes", "SELECT COUNT(*) FROM salary_history WHERE verification_status = 'pending'"],
    ["payitems.approve", "Allowances and loans", "/payroll/pay-items/review", "SELECT COUNT(*) FROM employee_pay_items WHERE status = 'pending'"],
    ["payroll.adjust.approve", "Payroll adjustments", "/payroll/adjustments/review", "SELECT COUNT(*) FROM payroll_adjustments WHERE status = 'pending'"],
    ["leave.review", "Leave requests", "/leave-requests", "SELECT COUNT(*) FROM leave_applications WHERE status = 'pending' AND supervisor_status IN ('approved','not_required')"],
    ["attendance.correction.review", "Attendance corrections", "/attendance/corrections", "SELECT COUNT(*) FROM attendance_correction_requests WHERE status = 'pending' AND supervisor_status IN ('approved','not_required')"],
    ["overtime.approve", "Overtime", "/overtime/review", "SELECT COUNT(*) FROM overtime_records WHERE status = 'pending' AND supervisor_status IN ('approved','not_required')"],
    ["bank.review", "Bank enrollments", "/bank-enrollments", "SELECT COUNT(*) FROM bank_enrollment_requests WHERE status = 'pending'"],
    ["accounting.adjust.approve", "Accounting entries", "/accounting/approvals", "SELECT COUNT(*) FROM accounting_transactions WHERE status = 'pending_approval'"],
    ["attendance.validate", "Attendance to validate", "/attendance/validation", "SELECT COUNT(*) FROM attendance_records WHERE validation_status = 'pending'"],
  ];
  const queues = [];
  for (const [perm, label, href, sql] of QUEUES) {
    if (!user.can(perm)) continue;
    const count = Number(await scalar(sql));
    if (count) queues.push({ label, href, count });
  }
  const [batches, notifications] = await Promise.all([
    user.can("payroll.view") ? select("SELECT b.id, b.batch_no, b.status, b.total_net, p.label AS period_label FROM payroll_batches b JOIN payroll_periods p ON p.id = b.period_id ORDER BY b.id DESC LIMIT 5") : [],
    select("SELECT title, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 5", [user.id]),
  ]);
  return { queues, batches, notifications };
}

// ---- ledger balances (posted journals; a reversed entry and its reversal cancel out) -------------------------------------
const POSTED = "j.status IN ('posted','reversed')";
// balance of an account and its sub-accounts, positive on the account's normal side
async function accountBalance(code, normal) {
  const sign = normal === "credit" ? "l.credit - l.debit" : "l.debit - l.credit";
  return Number(await scalar(
    `SELECT COALESCE(SUM(${sign}), 0) FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.entry_id AND ${POSTED}
       JOIN chart_of_accounts a ON a.id = l.account_id
       LEFT JOIN chart_of_accounts p ON p.id = a.parent_id
      WHERE a.code = ? OR p.code = ?`, [code, code]));
}
const cashBalance = async () => Number(await scalar(
  `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_entry_lines l
     JOIN journal_entries j ON j.id = l.entry_id AND ${POSTED}
     JOIN chart_of_accounts a ON a.id = l.account_id AND a.is_cash = 1`));
// net change in cash and bank accounts per month (money in minus money out; transfers between cash accounts net to zero)
async function cashFlowTrend(months) {
  const rows = await select(
    `SELECT DATE_FORMAT(j.entry_date, '%Y-%m') AS ym, SUM(l.debit - l.credit) AS net
       FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.entry_id AND ${POSTED}
       JOIN chart_of_accounts a ON a.id = l.account_id AND a.is_cash = 1
      WHERE j.entry_date >= ? GROUP BY ym`, [`${months[0].key}-01`]);
  return fill(months, rows, "net");
}
const queueTotal = (queues) => queues.reduce((n, q) => n + q.count, 0);

// ---- per-role dashboards (master prompt §XIII: four distinct dashboards) -------------------------------------------------
/** Accounting Supervisor: financial position and performance, payroll expense, cash flow and everything awaiting a decision. */
export async function supervisorDashboard(user) {
  const months = lastMonths(6);
  const [ie, trend, flow, ap, ar, cash, panels, activity, notes] = await Promise.all([
    incomeExpenseTrend(months), payrollTrend(months), cashFlowTrend(months),
    accountBalance("2010", "credit"), accountBalance("1100", "debit"), cashBalance(),
    dashboardPanels(user), recentAudit(null, null, 8), announcements("staff"),
  ]);
  const cur = months.length - 1;
  const net = ie.income[cur] - ie.expense[cur];
  const pending = queueTotal(panels.queues);
  return {
    kpis: [
      { label: "Revenue this month", value: formatPHP(ie.income[cur]), hint: "Posted journal entries", icon: "trending-up", href: "/accounting/income" },
      { label: "Expenses this month", value: formatPHP(ie.expense[cur]), hint: "Including payroll expense", icon: "receipt", href: "/accounting/expenses" },
      { label: "Net profit this month", value: formatPHP(net), hint: net < 0 ? "Net loss: expenses exceed revenue" : "Revenue minus expenses", icon: "bar-chart", tone: net < 0 ? "danger" : "success", href: "/reports/income-statement" },
      { label: "Payroll expense this month", value: formatPHP(trend.cost[cur]), hint: "Earned pay + employer contributions", icon: "wallet", href: "/reports/payroll-expense" },
      { label: "Accounts payable", value: formatPHP(ap), hint: "Ledger balance of account 2010", icon: "file-text", href: "/accounting/payables" },
      { label: "Accounts receivable", value: formatPHP(ar), hint: "Ledger balance of account 1100", icon: "inbox", href: "/accounting/receivables" },
      { label: "Cash on hand and in bank", value: formatPHP(cash), hint: "All cash accounts", icon: "bank", href: "/reports/cash-flow" },
      { label: "Pending approvals", value: pending, hint: pending ? panels.queues.map((q) => `${q.label} ${q.count}`).join(" · ") : "Nothing waiting for you", icon: "check-circle", tone: pending ? "warning" : undefined, href: panels.queues[0]?.href },
    ],
    charts: {
      months: months.map((m) => m.label),
      income: ie.income, expense: ie.expense, cashFlow: flow,
      payroll: { months: months.map((m) => m.label), cost: trend.cost, gross: trend.gross, net: trend.net },
    },
    panels, activity, announcements: notes,
  };
}

/** Payroll Staff: eligible employees, the current period's payroll totals, approvals, bank and statutory readiness, history. */
export async function staffDashboard(user) {
  const period = await currentPeriod();
  const [eligible, toProcess, totals, forReview, banks, statutory, validateCount, validation, activity, notes] = await Promise.all([
    scalar("SELECT COUNT(*) FROM employees WHERE deleted_at IS NULL AND employment_status = 'active'"),
    period
      ? scalar(
          `SELECT COUNT(*) FROM employees e
            WHERE e.deleted_at IS NULL AND e.employment_status = 'active'
              AND NOT EXISTS (SELECT 1 FROM payroll_records r WHERE r.employee_id = e.id AND r.period_id = ? AND r.active_flag = 1)`,
          [period.id])
      : null,
    // the open period's batches, or the latest batch when no period is open; voided batches never count
    period
      ? selectOne(`SELECT COUNT(*) AS batches, COALESCE(SUM(total_gross), 0) AS gross, COALESCE(SUM(total_deductions), 0) AS deductions, COALESCE(SUM(total_net), 0) AS net
                     FROM payroll_batches WHERE period_id = ? AND status <> 'voided'`, [period.id])
      : selectOne(`SELECT 1 AS batches, b.total_gross AS gross, b.total_deductions AS deductions, b.total_net AS net, p.label
                     FROM payroll_batches b JOIN payroll_periods p ON p.id = b.period_id WHERE b.status <> 'voided' ORDER BY b.id DESC LIMIT 1`),
    scalar("SELECT COUNT(*) FROM payroll_batches WHERE status = 'for_review'"),
    scalar("SELECT COUNT(*) FROM bank_enrollment_requests WHERE status = 'pending'"),
    scalar(`SELECT COUNT(*) FROM employees WHERE deleted_at IS NULL AND employment_status = 'active'
              AND (sss_no_enc IS NULL OR philhealth_no_enc IS NULL OR pagibig_no_enc IS NULL OR tin_enc IS NULL)`),
    scalar("SELECT COUNT(*) FROM attendance_records WHERE validation_status = 'pending' AND work_date >= DATE_SUB(CURDATE(), INTERVAL 31 DAY)"),
    select(
      `SELECT validation_status AS status, COUNT(*) AS n FROM attendance_records
        WHERE work_date >= DATE_SUB(CURDATE(), INTERVAL 31 DAY) GROUP BY validation_status`
    ),
    recentAudit(["payroll", "attendance", "overtime"], null, 8),
    announcements("staff"),
  ]);
  const v = (st) => Number(validation.find((r) => r.status === st)?.n || 0);
  const scope = period ? `For ${period.label}` : totals ? `Latest batch · ${totals.label}` : "No payroll batch yet";
  const t = totals || { gross: 0, deductions: 0, net: 0 };
  return {
    period,
    kpis: [
      { label: "Eligible employees", value: Number(eligible), hint: toProcess === null ? "Active employees · no open payroll period" : `${Number(toProcess)} not yet in a batch for ${period.label}`, icon: "users" },
      { label: "Gross payroll", value: formatPHP(t.gross), hint: scope, icon: "wallet", href: "/payroll" },
      { label: "Total deductions", value: formatPHP(t.deductions), hint: "Contributions, tax and other deductions", icon: "receipt", href: "/payroll" },
      { label: "Net payroll", value: formatPHP(t.net), hint: scope, icon: "bank", href: "/payroll" },
      { label: "Pending payroll approval", value: Number(forReview), hint: "Batches with the Accounting Supervisor", icon: "send", tone: Number(forReview) ? "warning" : undefined, href: "/payroll/batches?status=for_review" },
      { label: "Bank enrollments to verify", value: Number(banks), hint: "Waiting for verification", icon: "bank", tone: Number(banks) ? "warning" : undefined },
      { label: "Statutory enrollment gaps", value: Number(statutory), hint: "Active employees missing an SSS, PhilHealth, Pag-IBIG or TIN number", icon: "shield", tone: Number(statutory) ? "warning" : "success" },
      { label: "Attendance to validate", value: Number(validateCount), hint: "Last 31 days", icon: "clock", tone: Number(validateCount) ? "warning" : undefined, href: "/attendance/validation" },
    ],
    charts: {
      validation: [
        { key: "validated", name: "Validated", value: v("validated") },
        { key: "pending", name: "Pending validation", value: v("pending") },
        { key: "locked", name: "Locked by payroll", value: v("locked") },
      ],
    },
    activity,
    announcements: notes,
  };
}

/** Employee Self-Service: own pay, attendance, leave, overtime, bank and government enrollment, notifications. */
export async function employeeDashboard(user) {
  const empId = user.employee_id;
  if (!empId) return { unlinked: true };
  const year = new Date().getFullYear();
  await ensureBalances(empId, year);
  const [profile, payslip, attendance, balances, pendingLeave, pendingCorr, pendingBank, bank, overtime, gov, notifications, notes] = await Promise.all([
    selectOne(
      `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.employment_type, e.employment_status, e.date_hired,
              d.name AS department, p.title AS position
         FROM employees e JOIN departments d ON d.id = e.department_id JOIN positions p ON p.id = e.position_id
        WHERE e.id = ?`, [empId]
    ),
    // only RELEASED payslips are visible to employees
    selectOne(
      `SELECT s.id, s.payslip_no, r.net_pay, r.gross_pay, per.label AS period_label, s.released_at
         FROM payslips s JOIN payroll_records r ON r.id = s.record_id JOIN payroll_periods per ON per.id = r.period_id
        WHERE s.employee_id = ? AND s.status = 'released' AND r.status = 'released' ORDER BY s.released_at DESC LIMIT 1`, [empId]
    ),
    attendanceMonth(empId),
    select(
      `SELECT t.name, t.code, b.entitled_days, b.adjusted_days, b.used_days, b.pending_days
         FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
        WHERE b.employee_id = ? AND b.year = ? AND t.is_active = 1 ORDER BY t.name`, [empId, year]
    ),
    scalar("SELECT COUNT(*) FROM leave_applications WHERE employee_id = ? AND status = 'pending'", [empId]),
    scalar("SELECT COUNT(*) FROM attendance_correction_requests WHERE employee_id = ? AND status = 'pending'", [empId]),
    scalar("SELECT COUNT(*) FROM bank_enrollment_requests WHERE employee_id = ? AND status = 'pending'", [empId]),
    selectOne("SELECT bank_name, account_last4, account_type FROM bank_accounts WHERE employee_id = ? AND active_flag = 1", [empId]),
    selectOne(
      `SELECT COALESCE(SUM(CASE WHEN status = 'approved' THEN hours END), 0) AS approved, COALESCE(SUM(status = 'pending'), 0) AS pending
         FROM overtime_records WHERE employee_id = ? AND work_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`, [empId]
    ),
    // which government numbers are on file, never the numbers themselves
    selectOne("SELECT sss_no_enc IS NOT NULL AS sss, philhealth_no_enc IS NOT NULL AS philhealth, pagibig_no_enc IS NOT NULL AS pagibig, tin_enc IS NOT NULL AS tin FROM employees WHERE id = ?", [empId]),
    select("SELECT id, title, message, created_at, is_read, link_url FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 5", [user.id]),
    announcements("employees"),
  ]);
  const govList = [["SSS", gov.sss], ["PhilHealth", gov.philhealth], ["Pag-IBIG", gov.pagibig], ["TIN", gov.tin]].map(([name, on]) => ({ name, onFile: !!Number(on) }));
  return {
    profile, payslip, bank,
    payslips: await select(
      `SELECT s.id, r.gross_pay, r.net_pay, p.label AS period_label FROM payslips s JOIN payroll_records r ON r.id = s.record_id JOIN payroll_periods p ON p.id = r.period_id
        WHERE s.employee_id = ? AND s.status = 'released' AND r.status = 'released' ORDER BY p.end_date DESC LIMIT 3`, [empId]),
    attendance,
    leave: balances.map((b) => {
      const total = Number(b.entitled_days) + Number(b.adjusted_days);
      return { ...b, total, remaining: total - Number(b.used_days) - Number(b.pending_days), pct: total ? Math.max(0, Math.min(100, Math.round(((total - Number(b.used_days)) / total) * 100))) : 0 };
    }),
    overtime: { approved: Number(overtime.approved), pending: Number(overtime.pending) },
    gov: govList,
    govMissing: govList.filter((g) => !g.onFile).length,
    pending: { leave: Number(pendingLeave), corrections: Number(pendingCorr), bank: Number(pendingBank) },
    pendingTotal: Number(pendingLeave) + Number(pendingCorr) + Number(pendingBank),
    notifications,
    announcements: notes,
  };
}

/** Accounting Staff: today's transactions, revenue and expense records, payables and receivables, own entries, recent activity. */
export async function accountingStaffDashboard(user) {
  const months = lastMonths(6);
  const [trend, today, month, mine, waiting, recent, ap, ar, activity, notes, notifications, invoices, recon] = await Promise.all([
    incomeExpenseTrend(months),
    selectOne("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM accounting_transactions WHERE txn_date = CURDATE() AND status IN ('posted','pending_approval')"),
    selectOne(`SELECT COALESCE(SUM(txn_type = 'income'), 0) AS income_n, COALESCE(SUM(txn_type = 'expense'), 0) AS expense_n
                  FROM accounting_transactions WHERE status = 'posted' AND txn_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`),
    selectOne(`SELECT COALESCE(SUM(status = 'pending_approval'), 0) AS waiting,
                       COALESCE(SUM(status = 'rejected' AND updated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0) AS rejected
                  FROM accounting_transactions WHERE created_by = ?`, [user.id]),
    select("SELECT txn_no, txn_type, amount, description, created_at FROM accounting_transactions WHERE created_by = ? AND status = 'pending_approval' ORDER BY id DESC LIMIT 6", [user.id]),
    select("SELECT txn_no, txn_type, txn_date, amount, description, status FROM accounting_transactions WHERE created_by = ? ORDER BY id DESC LIMIT 8", [user.id]),
    accountBalance("2010", "credit"),
    accountBalance("1100", "debit"),
    recentAudit(["accounting"], null, 8),
    announcements("staff"),
    select("SELECT title, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 5", [user.id]),
    selectOne(`SELECT COALESCE(SUM(status = 'pending_approval'), 0) AS waiting, COALESCE(SUM(CASE WHEN status IN ('unpaid','partially_paid') AND due_date < CURDATE() THEN 1 END), 0) AS overdue,
                      COALESCE(SUM(CASE WHEN status IN ('unpaid','partially_paid') THEN 1 END), 0) AS open FROM supplier_invoices`),
    selectOne(`SELECT COUNT(*) AS open, (SELECT COUNT(*) FROM company_bank_accounts b WHERE b.is_active = 1 AND NOT EXISTS (SELECT 1 FROM bank_reconciliations r WHERE r.bank_account_id = b.id AND r.status = 'reconciled' AND r.statement_date >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH))) AS stale
                 FROM bank_reconciliations WHERE status = 'open'`),
  ]);
  const last = months.length - 1;
  return {
    kpis: [
      { label: "Today's transactions", value: Number(today.n), hint: `${formatPHP(today.amount)} recorded today, posted or waiting`, icon: "calendar" },
      { label: "Revenue entries this month", value: formatPHP(trend.income[last]), hint: `${Number(month.income_n)} posted income record(s)`, icon: "trending-up", href: "/accounting/income" },
      { label: "Expense records this month", value: formatPHP(trend.expense[last]), hint: `${Number(month.expense_n)} posted expense record(s), plus payroll`, icon: "receipt", href: "/accounting/expenses" },
      { label: "Accounts payable", value: formatPHP(ap), hint: "Ledger balance of account 2010", icon: "file-text", href: "/accounting/payables" },
      { label: "Accounts receivable", value: formatPHP(ar), hint: "Ledger balance of account 1100", icon: "inbox", href: "/accounting/receivables" },
      { label: "Supplier invoices", value: Number(invoices.open), hint: `${Number(invoices.waiting)} awaiting approval · ${Number(invoices.overdue)} overdue`, icon: "file-text", tone: Number(invoices.overdue) ? "danger" : undefined, href: "/accounting/payables" },
      { label: "Pending reconciliation", value: Number(recon.open), hint: `${Number(recon.stale)} bank account(s) not reconciled in the last month`, icon: "bank", tone: Number(recon.open) || Number(recon.stale) ? "warning" : undefined, href: "/accounting/banks" },
      { label: "My entries awaiting approval", value: Number(mine.waiting), hint: "With the Accounting Supervisor", icon: "clock", tone: Number(mine.waiting) ? "warning" : undefined },
      { label: "My entries rejected", value: Number(mine.rejected), hint: "Last 30 days", icon: "alert", tone: Number(mine.rejected) ? "danger" : undefined },
    ],
    charts: { months: months.map((m) => m.label), income: trend.income, expense: trend.expense },
    waiting, recent, activity, announcements: notes, notifications,
  };
}
