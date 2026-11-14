// Report catalogue. Each definition: key, title, group, perms (any-of), filters, run(filters) → { columns, rows, notes, subtitle }.
// Account numbers and government IDs never appear in a report; bank data is masked to the last four digits.
import { select, selectOne } from "../lib/db.js";
import { EARNED_SALARY_SQL } from "../lib/payrollCost.js";
import { toCents, fromCents } from "../lib/money.js";
import { fullName } from "./employeeService.js";
import { incomeStatement, balanceSheet, trialBalance, generalLedger, cashFlow, monthlyFinancials } from "./financialStatements.js";

const money = (key, label) => ({ key, label, type: "money" });
const num = (key, label) => ({ key, label, type: "num" });
const text = (key, label) => ({ key, label });
const date = (key, label) => ({ key, label, type: "date" });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HR = ["reports.view"], FIN = ["reports.financial"];
const humanize = (s) => String(s ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const dept = (f, alias = "e") => (f.department ? [`AND ${alias}.department_id = ?`, [f.department]] : ["", []]);
const range = (f) => `${f.from} to ${f.to}`;

/** Sums money columns into a grand-total row. */
function totals(rows, keys, label, labelKey) {
  const out = { _kind: "grand", [labelKey]: label };
  for (const k of keys) out[k] = fromCents(rows.reduce((s, r) => s + toCents(r[k] || 0), 0));
  return out;
}

export const REPORTS = {
  employeeMasterlist: {
    key: "employee-masterlist", title: "Employee Masterlist", group: "People", perms: HR, filters: ["department", "status"],
    async run(f) {
      const [d, dp] = dept(f);
      const rows = await select(
        `SELECT e.*, dp.name AS department, p.title AS position, (SELECT CONCAT(b.bank_name,' ••••',b.account_last4) FROM bank_accounts b WHERE b.employee_id = e.id AND b.active_flag = 1 LIMIT 1) AS bank
           FROM employees e JOIN departments dp ON dp.id = e.department_id JOIN positions p ON p.id = e.position_id
          WHERE e.deleted_at IS NULL ${f.status ? "AND e.employment_status = ?" : ""} ${d} ORDER BY e.last_name, e.first_name`, [...(f.status ? [f.status] : []), ...dp]);
      return { columns: [text("no", "ID"), text("name", "Employee"), text("department", "Department"), text("position", "Position"), text("type", "Type"), text("status", "Status"), date("hired", "Hired"), money("rate", "Rate"), text("basis", "Basis"), text("bank", "Bank")],
        rows: rows.map((e) => ({ no: e.employee_no, name: fullName(e), department: e.department, position: e.position, type: humanize(e.employment_type), status: humanize(e.employment_status), hired: e.date_hired, rate: e.basic_salary, basis: humanize(e.rate_basis), bank: e.bank || "Not enrolled" })) };
    },
  },
  payrollRegister: {
    key: "payroll-register", title: "Payroll Register", group: "Payroll", perms: HR, filters: ["period", "department"],
    async run(f) {
      if (!f.period) return { columns: [text("employee", "Employee")], rows: [], notes: ["Select a payroll period."] };
      const p = await selectOne("SELECT label FROM payroll_periods WHERE id = ?", [f.period]);
      const [d, dp] = dept(f);
      const rows = await select(`SELECT r.*, b.batch_no FROM payroll_records r JOIN payroll_batches b ON b.id = r.batch_id JOIN employees e ON e.id = r.employee_id WHERE r.period_id = ? AND r.active_flag = 1 ${d} ORDER BY r.employee_name`, [f.period, ...dp]);
      const keys = ["basic_pay", "overtime_pay", "holiday_pay", "allowances", "other_earnings", "gross_pay", "statutory_employee", "withholding_tax", "other_deductions", "net_pay"];
      return { subtitle: p?.label, columns: [text("employee_name", "Employee"), text("status", "Status"), money("basic_pay", "Basic"), money("overtime_pay", "OT"), money("holiday_pay", "Holiday"), money("allowances", "Allow."), money("other_earnings", "Other"), money("gross_pay", "Gross"), money("statutory_employee", "Contrib."), money("withholding_tax", "Tax"), money("other_deductions", "Other Ded."), money("net_pay", "Net")],
        rows: [...rows.map((r) => ({ ...r, status: humanize(r.status) })), ...(rows.length ? [totals(rows, keys, "Totals", "employee_name")] : [])] };
    },
  },
  monthlyPayroll: {
    key: "monthly-payroll", title: "Monthly Payroll Report", group: "Payroll", perms: HR, filters: ["year"],
    async run(f) {
      const rows = await select(
        `SELECT MONTH(p.end_date) AS mo, COUNT(DISTINCT r.employee_id) AS employees, SUM(r.gross_pay) AS gross, SUM(r.statutory_employee) AS contrib, SUM(r.withholding_tax) AS tax, SUM(r.other_deductions) AS other, SUM(r.net_pay) AS net, SUM(r.employer_contributions) AS employer
           FROM payroll_records r JOIN payroll_periods p ON p.id = r.period_id WHERE r.status IN ('finalized','released') AND r.active_flag = 1 AND YEAR(p.end_date) = ? GROUP BY mo ORDER BY mo`, [f.year]);
      const out = rows.map((r) => ({ month: MONTHS[r.mo - 1], employees: r.employees, gross: r.gross, contrib: r.contrib, tax: r.tax, other: r.other, net: r.net, employer: r.employer, cost: fromCents(toCents(r.gross) + toCents(r.employer)) }));
      return { subtitle: String(f.year), columns: [text("month", "Month"), num("employees", "Employees"), money("gross", "Gross"), money("contrib", "Contrib."), money("tax", "Tax"), money("other", "Other Ded."), money("net", "Net"), money("employer", "Employer"), money("cost", "Total Cost")],
        rows: [...out, ...(out.length ? [totals(out, ["gross", "contrib", "tax", "other", "net", "employer", "cost"], "Totals", "month")] : [])], notes: ["Finalized and released payroll only."] };
    },
  },
  payrollExpense: {
    key: "payroll-expense", title: "Payroll Expense Report", group: "Payroll", perms: HR, filters: ["from", "to"],
    async run(f) {
      const rows = await select(
        `SELECT COALESCE(r.department_name,'—') AS department, COUNT(DISTINCT r.employee_id) AS employees, SUM(${EARNED_SALARY_SQL}) AS salaries, SUM(r.overtime_pay) AS overtime, SUM(r.employer_contributions) AS employer
           FROM payroll_records r JOIN payroll_periods p ON p.id = r.period_id WHERE r.status IN ('finalized','released') AND r.active_flag = 1 AND p.end_date BETWEEN ? AND ? GROUP BY r.department_name ORDER BY department`, [f.from, f.to]);
      const out = rows.map((r) => ({ ...r, cost: fromCents(toCents(r.salaries) + toCents(r.overtime) + toCents(r.employer)) }));
      return { subtitle: range(f), columns: [text("department", "Department"), num("employees", "Employees"), money("salaries", "Salaries"), money("overtime", "Overtime"), money("employer", "Employer Share"), money("cost", "Total Cost")], rows: [...out, ...(out.length ? [totals(out, ["salaries", "overtime", "employer", "cost"], "Totals", "department")] : [])] };
    },
  },
  employeeCompensation: {
    key: "employee-compensation", title: "Employee Compensation Report", group: "Payroll", perms: HR, filters: ["year", "department"],
    async run(f) {
      const [d, dp] = dept(f);
      const rows = await select(
        `SELECT r.employee_no, r.employee_name, MAX(r.department_name) AS department, COUNT(*) AS periods, SUM(r.gross_pay) AS gross, SUM(r.overtime_pay) AS overtime, SUM(r.total_deductions) AS deductions, SUM(r.net_pay) AS net, SUM(r.employer_contributions) AS employer
           FROM payroll_records r JOIN payroll_periods p ON p.id = r.period_id JOIN employees e ON e.id = r.employee_id WHERE r.status IN ('finalized','released') AND r.active_flag = 1 AND YEAR(p.end_date) = ? ${d} GROUP BY r.employee_no, r.employee_name ORDER BY r.employee_name`, [f.year, ...dp]);
      return { subtitle: String(f.year), columns: [text("employee_no", "ID"), text("employee_name", "Employee"), text("department", "Department"), num("periods", "Periods"), money("gross", "Gross"), money("overtime", "Overtime"), money("deductions", "Deductions"), money("net", "Net"), money("employer", "Employer")],
        rows: [...rows, ...(rows.length ? [totals(rows, ["gross", "overtime", "deductions", "net", "employer"], "Totals", "employee_name")] : [])] };
    },
  },
  deductionSummary: {
    key: "deduction-summary", title: "Deduction Summary", group: "Payroll", perms: HR, filters: ["from", "to"],
    async run(f) {
      const contrib = await select(
        `SELECT pc.agency, SUM(pc.employee_share) AS ee, SUM(pc.employer_share + pc.ec_share) AS er FROM payroll_contributions pc JOIN payroll_records r ON r.id = pc.record_id JOIN payroll_periods p ON p.id = r.period_id
          WHERE r.status IN ('finalized','released') AND r.active_flag = 1 AND p.end_date BETWEEN ? AND ? GROUP BY pc.agency`, [f.from, f.to]);
      const other = await select(
        `SELECT c.name, SUM(d.amount) AS total FROM payroll_deductions d JOIN salary_components c ON c.id = d.component_id JOIN payroll_records r ON r.id = d.record_id JOIN payroll_periods p ON p.id = r.period_id
          WHERE r.status IN ('finalized','released') AND r.active_flag = 1 AND p.end_date BETWEEN ? AND ? AND c.category <> 'statutory' GROUP BY c.name ORDER BY c.name`, [f.from, f.to]);
      const rows = [...contrib.map((c) => ({ item: `${c.agency} contribution`, employee: c.ee, employer: c.er })), ...other.map((o) => ({ item: o.name, employee: o.total, employer: "0.00" }))];
      return { subtitle: range(f), columns: [text("item", "Deduction"), money("employee", "Employee"), money("employer", "Employer")], rows: [...rows, ...(rows.length ? [totals(rows, ["employee", "employer"], "Totals", "item")] : [])] };
    },
  },
  attendanceSummary: {
    key: "attendance-summary", title: "Attendance Summary", group: "Time & Leave", perms: HR, filters: ["from", "to", "department"],
    async run(f) {
      const [d, dp] = dept(f);
      const rows = await select(
        `SELECT e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, SUM(a.status='present') AS present, SUM(a.status='late') AS late, SUM(a.status='half_day') AS half_day, SUM(a.status='absent') AS absent, SUM(a.status='on_leave') AS on_leave, SUM(a.late_minutes) AS late_min, SUM(a.undertime_minutes) AS ut_min, SUM(a.hours_worked) AS hours
           FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE a.work_date BETWEEN ? AND ? ${d} GROUP BY e.id ORDER BY e.last_name, e.first_name`, [f.from, f.to, ...dp]);
      return { subtitle: range(f), columns: [text("employee_no", "ID"), text("name", "Employee"), num("present", "Present"), num("late", "Late"), num("half_day", "Half Day"), num("absent", "Absent"), num("on_leave", "Leave"), num("late_min", "Late Min"), num("ut_min", "UT Min"), num("hours", "Hours")], rows: rows.map((r) => ({ ...r, name: fullName(r) })) };
    },
  },
  dailyTimeRecords: {
    key: "daily-time-records", title: "Daily Time Records", group: "Time & Leave", perms: HR, filters: ["from", "to", "employee"],
    async run(f) {
      if (!f.employee) return { columns: [text("date", "Date")], rows: [], notes: ["Select an employee."] };
      const e = await selectOne("SELECT first_name, middle_name, last_name, suffix, employee_no FROM employees WHERE id = ?", [f.employee]);
      const rows = await select("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date", [f.employee, f.from, f.to]);
      const time = (t) => (t ? String(t).slice(0, 5) : "");
      return { subtitle: e ? `${fullName(e)} (${e.employee_no}) · ${range(f)}` : range(f), columns: [date("date", "Date"), text("in", "In"), text("out", "Out"), text("status", "Status"), num("hours", "Hours"), num("late", "Late"), num("ut", "UT"), text("validation", "Validation")],
        rows: rows.map((a) => ({ date: a.work_date, in: time(a.time_in), out: time(a.time_out), status: humanize(a.status), hours: a.hours_worked, late: a.late_minutes, ut: a.undertime_minutes, validation: humanize(a.validation_status) })) };
    },
  },
  overtimeSummary: {
    key: "overtime-summary", title: "Overtime Summary", group: "Time & Leave", perms: HR, filters: ["from", "to", "department"],
    async run(f) {
      const [d, dp] = dept(f);
      const rows = await select(
        `SELECT e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, SUM(IF(o.ot_type='regular',o.hours,0)) AS regular, SUM(IF(o.ot_type='rest_day',o.hours,0)) AS rest_day, SUM(IF(o.ot_type='holiday',o.hours,0)) AS holiday, SUM(o.hours) AS total
           FROM overtime_records o JOIN employees e ON e.id = o.employee_id WHERE o.status = 'approved' AND o.work_date BETWEEN ? AND ? ${d} GROUP BY e.id ORDER BY e.last_name`, [f.from, f.to, ...dp]);
      return { subtitle: range(f), columns: [text("employee_no", "ID"), text("name", "Employee"), num("regular", "Regular h"), num("rest_day", "Rest Day h"), num("holiday", "Holiday h"), num("total", "Total h")], rows: rows.map((r) => ({ ...r, name: fullName(r) })), notes: ["Approved overtime only."] };
    },
  },
  leaveSummary: {
    key: "leave-summary", title: "Leave Summary", group: "Time & Leave", perms: HR, filters: ["year", "department"],
    async run(f) {
      const [d, dp] = dept(f);
      const rows = await select(
        `SELECT e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, t.name AS type, b.entitled_days, b.adjusted_days, b.used_days, b.pending_days
           FROM leave_balances b JOIN employees e ON e.id = b.employee_id JOIN leave_types t ON t.id = b.leave_type_id WHERE b.year = ? AND e.deleted_at IS NULL ${d} ORDER BY e.last_name, t.name`, [f.year, ...dp]);
      return { subtitle: String(f.year), columns: [text("employee_no", "ID"), text("name", "Employee"), text("type", "Leave Type"), num("entitled_days", "Entitled"), num("adjusted_days", "Adjusted"), num("used_days", "Used"), num("pending_days", "Pending"), num("remaining", "Remaining")],
        rows: rows.map((r) => ({ ...r, name: fullName(r), remaining: (Number(r.entitled_days) + Number(r.adjusted_days) - Number(r.used_days) - Number(r.pending_days)).toFixed(1) })) };
    },
  },
  bankEnrollmentSummary: {
    key: "bank-enrollment-summary", title: "Bank Enrollment Summary", group: "People", perms: HR, filters: ["department"],
    async run(f) {
      const [d, dp] = dept(f);
      const rows = await select(
        `SELECT e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, b.bank_name, b.account_last4, b.account_type, b.approved_at,
                (SELECT COUNT(*) FROM bank_enrollment_requests r WHERE r.employee_id = e.id AND r.status = 'pending') AS pending
           FROM employees e LEFT JOIN bank_accounts b ON b.employee_id = e.id AND b.active_flag = 1 WHERE e.deleted_at IS NULL AND e.employment_status IN ('active','on_leave') ${d} ORDER BY e.last_name`, dp);
      return { columns: [text("employee_no", "ID"), text("name", "Employee"), text("bank", "Bank"), text("account", "Account"), text("type", "Type"), text("status", "Status")],
        rows: rows.map((r) => ({ employee_no: r.employee_no, name: fullName(r), bank: r.bank_name || "—", account: r.account_last4 ? `••••${r.account_last4}` : "—", type: r.account_type ? humanize(r.account_type) : "—", status: r.bank_name ? "Enrolled" : Number(r.pending) ? "Pending approval" : "Not enrolled" })),
        notes: ["Account numbers are masked to the last four digits."] };
    },
  },
  expenseReport: {
    key: "expense-report", title: "Expense Report", group: "Financial", perms: FIN, filters: ["from", "to", "category"],
    run: (f) => transactionReport("expense", f),
  },
  incomeReport: {
    key: "income-report", title: "Income Report", group: "Financial", perms: FIN, filters: ["from", "to", "category"],
    run: (f) => transactionReport("income", f),
  },
  incomeStatement: { key: "income-statement", title: "Income Statement", group: "Financial", perms: FIN, filters: ["from", "to"], run: async (f) => ({ ...(await incomeStatement(f.from, f.to)), subtitle: range(f) }) },
  balanceSheet: { key: "balance-sheet", title: "Balance Sheet", group: "Financial", perms: FIN, filters: ["asOf"], run: async (f) => ({ ...(await balanceSheet(f.asOf)), subtitle: `As of ${f.asOf}` }) },
  cashFlow: { key: "cash-flow", title: "Cash Flow Statement", group: "Financial", perms: FIN, filters: ["from", "to"], run: async (f) => ({ ...(await cashFlow(f.from, f.to)), subtitle: range(f) }) },
  trialBalance: { key: "trial-balance", title: "Trial Balance", group: "Financial", perms: FIN, filters: ["asOf"], run: async (f) => ({ ...(await trialBalance(f.asOf)), subtitle: `As of ${f.asOf}` }) },
  generalLedger: { key: "general-ledger", title: "General Ledger", group: "Financial", perms: FIN, filters: ["from", "to", "account"], run: async (f) => ({ ...(await generalLedger(f.account, f.from, f.to)), subtitle: range(f) }) },
  financialAnalytics: {
    key: "financial-analytics", title: "Financial Analytics Report", group: "Financial", perms: FIN, filters: ["year"],
    async run(f) {
      const data = await monthlyFinancials(f.year);
      const out = data.map((m) => ({ month: MONTHS[m.mo - 1], revenue: fromCents(m.revenue), expense: fromCents(m.expense), payroll: fromCents(m.payroll), net: fromCents(m.net), margin: m.revenue ? `${((m.net / m.revenue) * 100).toFixed(1)}%` : "—" }));
      const t = totals(out, ["revenue", "expense", "payroll", "net"], "Totals", "month");
      const rev = toCents(t.revenue);
      t.margin = rev ? `${((toCents(t.net) / rev) * 100).toFixed(1)}%` : "—";
      return { subtitle: String(f.year), columns: [text("month", "Month"), money("revenue", "Revenue"), money("expense", "Expenses"), money("payroll", "of which Payroll"), money("net", "Net Income"), text("margin", "Margin")], rows: [...out, t] };
    },
  },
};

async function transactionReport(type, f) {
  const rows = await select(
    `SELECT t.txn_no, t.txn_date, t.description, t.reference_no, t.payment_method, t.amount, c.name AS category FROM accounting_transactions t LEFT JOIN transaction_categories c ON c.id = t.category_id
      WHERE t.txn_type = ? AND t.status = 'posted' AND t.txn_date BETWEEN ? AND ? ${f.category ? "AND t.category_id = ?" : ""} ORDER BY t.txn_date, t.id`, [type, f.from, f.to, ...(f.category ? [f.category] : [])]);
  const out = rows.map((r) => ({ ...r, payment_method: humanize(r.payment_method) }));
  return { subtitle: range(f), columns: [text("txn_no", "No."), date("txn_date", "Date"), text("category", "Category"), text("description", "Description"), text("reference_no", "Reference"), text("payment_method", "Method"), money("amount", "Amount")],
    rows: [...out, ...(out.length ? [totals(out, ["amount"], "Total", "description")] : [])],
    notes: type === "expense" ? ["Excludes payroll, which is posted by payroll batches. See the Income Statement for total expenses."] : [] };
}

