// Salary loans (Employee Self-Service), on the policy most Philippine companies use. Every limit is in System Settings
// (loans.*): regular employees with at least 12 months of service may borrow up to 2 months of basic salary, to be repaid
// in 3, 6 or 12 months with 1% a month add-on interest, by payroll deduction every payday. One loan at a time, and the
// payday deduction may not exceed 25% of the payday basic pay.
// Flow: the employee applies → Accounting/Payroll Staff or the Accounting Supervisor approve or reject (never their own)
// → Payroll Staff release the money (journal: Dr 1100 loan receivable, Cr 1020 cash, Cr 4020 interest income) and the
// loan becomes an approved LOAN pay item with a running balance → payroll deducts it every payday until it is paid.
// Anything still owed at separation is deducted from the final pay.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyEmployee, notifyPermission } from "../lib/notify.js";
import { nextDocNo } from "../lib/sequence.js";
import { getSetting } from "../lib/settings.js";
import { toCents, fromCents } from "../lib/money.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { postEntry } from "./journalService.js";
import { fullName } from "./employeeService.js";

const PAYDAYS_PER_MONTH = { semi_monthly: 2, monthly: 1, weekly: 52 / 12 };
const manilaToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

export async function loanPolicy() {
  return {
    eligibleTypes: String(await getSetting("loans.eligible_types", "regular")).split(",").map((s) => s.trim()).filter(Boolean),
    minServiceMonths: Number(await getSetting("loans.min_service_months", 12)),
    maxMultiple: Number(await getSetting("loans.max_salary_multiple", 2)),
    minAmount: Number(await getSetting("loans.min_amount", 1000)),
    terms: String(await getSetting("loans.terms", "3,6,12")).split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0),
    interestRate: Number(await getSetting("loans.interest_rate_monthly", 0.01)),
    maxDeductionPercent: Number(await getSetting("loans.max_deduction_percent", 25)),
    daysPerYear: Number(await getSetting("payroll.days_per_year", 261)),
  };
}

/** Whole months of service between two dates (pure). */
export function serviceMonths(hired, today) {
  const a = new Date(`${String(hired).slice(0, 10)}T00:00:00`), b = new Date(`${String(today).slice(0, 10)}T00:00:00`);
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return Math.max(0, m);
}

/**
 * A loan's figures (pure; exported for unit tests). Amounts in pesos.
 * Add-on interest: principal × rate × months. Paydays = months × paydays a month. The payday deduction is the total ÷ paydays,
 * rounded up to the centavo (the last payday takes only what is left).
 */
export function loanQuote({ principal, termMonths, monthlyBasic, payFrequency }, policy) {
  const pC = toCents(principal);
  const interestC = Math.round(pC * policy.interestRate * termMonths);
  const totalC = pC + interestC;
  const paydays = Math.round(termMonths * (PAYDAYS_PER_MONTH[payFrequency] || 2));
  const amortC = Math.ceil(totalC / paydays);
  const paydayBasicC = toCents(monthlyBasic) / (PAYDAYS_PER_MONTH[payFrequency] || 2);
  const maxDeductionC = Math.floor((paydayBasicC * policy.maxDeductionPercent) / 100);
  const maxLoanC = Math.floor(toCents(monthlyBasic) * policy.maxMultiple);
  const errors = [];
  if (!policy.terms.includes(termMonths)) errors.push(`Choose a term of ${policy.terms.join(", ")} months.`);
  if (pC < toCents(policy.minAmount)) errors.push(`The smallest loan is ₱${fromCents(toCents(policy.minAmount))}.`);
  if (pC > maxLoanC) errors.push(`You can borrow up to ${policy.maxMultiple} months of basic salary: ₱${fromCents(maxLoanC)}.`);
  if (amortC > maxDeductionC) errors.push(`The payday deduction of ₱${fromCents(amortC)} would be more than ${policy.maxDeductionPercent}% of your payday basic pay (₱${fromCents(maxDeductionC)}). Borrow less or choose a longer term.`);
  return {
    principal: fromCents(pC), interest: fromCents(interestC), total: fromCents(totalC), paydays, amortization: fromCents(amortC),
    maxLoan: fromCents(maxLoanC), maxDeduction: fromCents(maxDeductionC), errors,
  };
}

/** The employee's basic salary in force today, as a monthly figure (daily rates × days a year ÷ 12). */
async function monthlyBasic(employeeId, policy, trx = null) {
  const e = await selectOne("SELECT basic_salary, rate_basis, pay_frequency FROM employees WHERE id = ?", [employeeId], trx);
  const h = await selectOne(
    `SELECT new_amount, rate_basis FROM salary_history WHERE employee_id = ? AND verification_status <> 'rejected' AND effective_date <= ?
      ORDER BY effective_date DESC, id DESC LIMIT 1`, [employeeId, manilaToday()], trx);
  const rate = toCents(h ? h.new_amount : e.basic_salary), basis = h ? h.rate_basis : e.rate_basis;
  const hpd = Number(await getSetting("attendance.hours_per_day", 8));
  const monthlyC = basis === "monthly" ? rate : basis === "daily" ? Math.round((rate * policy.daysPerYear) / 12) : Math.round((rate * hpd * policy.daysPerYear) / 12);
  return { monthly: fromCents(monthlyC), payFrequency: e.pay_frequency };
}

export async function eligibility(employeeId, trx = null) {
  const policy = await loanPolicy();
  const emp = await selectOne("SELECT id, employment_type, employment_status, date_hired FROM employees WHERE id = ?", [employeeId], trx);
  const months = emp ? serviceMonths(emp.date_hired, manilaToday()) : 0;
  const open = await selectOne("SELECT loan_no, status FROM salary_loans WHERE employee_id = ? AND active_flag = 1", [employeeId], trx);
  const reasons = [];
  if (!emp) reasons.push("Your account is not linked to an HR employee record.");
  else {
    if (!["active", "on_leave"].includes(emp.employment_status)) reasons.push(`Your HR record says you are ${emp.employment_status.replace("_", " ")}; loans are for active employees.`);
    if (!policy.eligibleTypes.includes(emp.employment_type)) reasons.push(`Salary loans are for ${policy.eligibleTypes.join(", ")} employees; you are ${emp.employment_type.replace("_", " ")}.`);
    if (months < policy.minServiceMonths) reasons.push(`You need ${policy.minServiceMonths} months of service; you have ${months}.`);
  }
  if (open) reasons.push(`You already have loan ${open.loan_no} (${open.status}). One loan at a time.`);
  const basic = emp ? await monthlyBasic(employeeId, policy, trx) : null;
  return { eligible: reasons.length === 0, reasons, months, policy, basic };
}

export async function myLoans(employeeId) {
  const elig = await eligibility(employeeId);
  const loans = await select(
    `SELECT l.*, i.remaining_balance, i.status AS item_status, d.full_name AS decided_by_name
       FROM salary_loans l LEFT JOIN employee_pay_items i ON i.id = l.pay_item_id LEFT JOIN users d ON d.id = l.decided_by
      WHERE l.employee_id = ? ORDER BY l.id DESC`, [employeeId]);
  const paidSoFar = (l) => (l.remaining_balance === null || l.remaining_balance === undefined ? "0.00" : fromCents(toCents(l.total_payable) - toCents(l.remaining_balance)));
  return {
    ...elig,
    maxLoan: elig.basic ? fromCents(Math.floor(toCents(elig.basic.monthly) * elig.policy.maxMultiple)) : "0.00",
    loans: loans.map((l) => ({ ...l, paid: paidSoFar(l), pct: l.remaining_balance !== null && l.remaining_balance !== undefined ? Math.round(((toCents(l.total_payable) - toCents(l.remaining_balance)) / toCents(l.total_payable)) * 100) : 0 })),
  };
}

export function checkApplication(body) {
  const v = { principal: String(body.principal || "").replace(/,/g, "").trim(), term_months: Number(body.term_months), purpose: String(body.purpose || "").trim().slice(0, 255) };
  const errors = {};
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v.principal)) errors.principal = "Enter the amount (up to 2 decimals).";
  if (!Number.isInteger(v.term_months)) errors.term_months = "Choose the term.";
  if (v.purpose.length < 5) errors.purpose = "State the purpose of the loan.";
  return { values: v, errors };
}

export async function apply(req, v) {
  const employeeId = req.user.employee_id;
  return tx(async (trx) => {
    await selectOne("SELECT id FROM employees WHERE id = ? FOR UPDATE", [employeeId], trx);
    const elig = await eligibility(employeeId, trx);
    if (!elig.eligible) throw badRequest(elig.reasons.join(" "));
    const q = loanQuote({ principal: v.principal, termMonths: v.term_months, monthlyBasic: elig.basic.monthly, payFrequency: elig.basic.payFrequency }, elig.policy);
    if (q.errors.length) throw badRequest(q.errors.join(" "));
    const no = await nextDocNo("SL", 4, trx);
    const { insertId } = await exec(
      `INSERT INTO salary_loans (loan_no, employee_id, principal, term_months, interest_rate, interest_amount, total_payable, paydays, amortization, monthly_basic, purpose, requested_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [no, employeeId, q.principal, v.term_months, elig.policy.interestRate, q.interest, q.total, q.paydays, q.amortization, elig.basic.monthly, v.purpose, req.user.id], trx);
    await audit(req, { action: "salary_loan_applied", module: "payroll", recordType: "salary_loan", recordId: insertId, next: { loan_no: no, principal: q.principal, term: v.term_months, total: q.total, amortization: q.amortization } }, trx);
    await notifyPermission("loans.approve", { type: "salary_loan", title: "Salary loan to approve", message: `${req.user.full_name}: ₱${q.principal} over ${v.term_months} months (${no}).`, relatedType: "salary_loan", relatedId: insertId, link: "/payroll/loans" }, { excludeUserId: req.user.id }, trx);
    return { no, ...q };
  });
}

export async function cancel(req, id) {
  const l = await selectOne("SELECT * FROM salary_loans WHERE id = ?", [id]);
  if (!l || l.employee_id !== req.user.employee_id) throw notFound("Loan not found.");
  if (l.status !== "pending") throw badRequest("Only a pending application can be cancelled.");
  await exec("UPDATE salary_loans SET status = 'cancelled', active_flag = NULL WHERE id = ?", [id]);
  await audit(req, { action: "salary_loan_cancelled", module: "payroll", recordType: "salary_loan", recordId: id });
}

export async function queue(status = "open") {
  const st = ["open", "pending", "approved", "released", "paid", "rejected", "all"].includes(status) ? status : "open";
  const where = st === "all" ? "" : st === "open" ? "WHERE l.status IN ('pending','approved')" : "WHERE l.status = ?";
  const rows = await select(
    `SELECT l.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, e.date_hired, dp.name AS department,
            i.remaining_balance, u.full_name AS decided_by_name, x.full_name AS released_by_name
       FROM salary_loans l JOIN employees e ON e.id = l.employee_id JOIN departments dp ON dp.id = e.department_id
       LEFT JOIN employee_pay_items i ON i.id = l.pay_item_id LEFT JOIN users u ON u.id = l.decided_by LEFT JOIN users x ON x.id = l.released_by
      ${where} ORDER BY FIELD(l.status, 'pending', 'approved', 'released', 'paid', 'rejected', 'cancelled'), l.id DESC LIMIT 200`,
    ["open", "all"].includes(st) ? [] : [st]);
  const totals = await selectOne(
    `SELECT COUNT(*) AS n, COALESCE(SUM(i.remaining_balance), 0) AS outstanding FROM salary_loans l JOIN employee_pay_items i ON i.id = l.pay_item_id WHERE l.status = 'released'`);
  return { status: st, rows: rows.map((r) => ({ ...r, name: fullName(r) })), totals };
}

export async function decide(req, id, action, remarks) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting.");
  return tx(async (trx) => {
    const l = await selectOne("SELECT * FROM salary_loans WHERE id = ? FOR UPDATE", [id], trx);
    if (!l) throw notFound("Loan not found.");
    if (l.status !== "pending") throw badRequest(`This loan was already ${l.status}.`);
    if (l.requested_by === req.user.id || (req.user.employee_id && l.employee_id === req.user.employee_id)) throw forbidden("You cannot decide on your own loan.");
    await exec(`UPDATE salary_loans SET status = ?, active_flag = ${action === "approved" ? "1" : "NULL"}, decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?`,
      [action, req.user.id, remarks || null, id], trx);
    await audit(req, { action: `salary_loan_${action}`, module: "payroll", recordType: "salary_loan", recordId: id, decision: action, remarks }, trx);
    await notifyEmployee(l.employee_id, {
      type: `salary_loan_${action}`, title: action === "approved" ? "Salary loan approved" : "Salary loan rejected",
      message: action === "approved" ? `${l.loan_no} was approved. Payroll will release ₱${l.principal}.` : `${l.loan_no} was rejected: ${remarks}`,
      relatedType: "salary_loan", relatedId: id, link: "/my/loans",
    }, trx);
    if (action === "approved") await notifyPermission("loans.release", { type: "salary_loan_release", title: "Salary loan to release", message: `${l.loan_no}: ₱${l.principal}.`, relatedType: "salary_loan", relatedId: id, link: "/payroll/loans" }, { excludeUserId: req.user.id }, trx);
    return l;
  });
}

export async function release(req, id, reference) {
  reference = String(reference || "").trim().slice(0, 100);
  if (!reference) throw badRequest("Enter the release reference (check or transfer number).");
  return tx(async (trx) => {
    const l = await selectOne("SELECT * FROM salary_loans WHERE id = ? FOR UPDATE", [id], trx);
    if (!l) throw notFound("Loan not found.");
    if (l.status !== "approved") throw badRequest("Only an approved loan can be released.");
    if (req.user.employee_id && l.employee_id === req.user.employee_id) throw forbidden("You cannot release your own loan.");
    const comp = await selectOne("SELECT id FROM salary_components WHERE code = 'LOAN'", [], trx);
    const today = manilaToday();
    // the loan becomes a LOAN deduction with a running balance: payroll deducts the amortization every payday until it is paid
    const { insertId: itemId } = await exec(
      `INSERT INTO employee_pay_items (employee_id, component_id, description, amount, remaining_balance, effective_from, status, submitted_by, decided_by, decided_at)
       VALUES (?,?,?,?,?,?, 'approved', ?, ?, NOW())`,
      [l.employee_id, comp.id, `Salary loan ${l.loan_no}`, l.amortization, l.total_payable, today, l.requested_by, l.decided_by], trx);
    await exec("UPDATE salary_loans SET status = 'released', released_by = ?, released_at = NOW(), release_reference = ?, pay_item_id = ? WHERE id = ?", [req.user.id, reference, itemId, id], trx);
    const emp = await selectOne("SELECT first_name, middle_name, last_name, suffix FROM employees WHERE id = ?", [l.employee_id], trx);
    await postEntry({ req, date: today, description: `Salary loan ${l.loan_no} released to ${fullName(emp)} (${reference})`, sourceType: "salary_loan", sourceId: id, sourceEvent: "release",
      lines: [
        { account: "1100", debit: toCents(l.total_payable), description: "Employee loan receivable (principal and interest)" },
        { account: "1020", credit: toCents(l.principal), description: `Loan released (${reference})` },
        { account: "4020", credit: toCents(l.interest_amount), description: "Interest on the employee loan" },
      ] }, trx);
    await audit(req, { action: "salary_loan_released", module: "payroll", recordType: "salary_loan", recordId: id, next: { reference, pay_item_id: itemId, amortization: l.amortization } }, trx);
    await notifyEmployee(l.employee_id, { type: "salary_loan_released", title: "Salary loan released", message: `₱${l.principal} was released (${reference}). ₱${l.amortization} will be deducted every payday.`, relatedType: "salary_loan", relatedId: id, link: "/my/loans" }, trx);
  });
}

export const pendingLoans = () => scalar("SELECT COUNT(*) FROM salary_loans WHERE status = 'pending'").then(Number);
