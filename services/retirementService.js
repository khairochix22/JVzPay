// Retirement fund. The employee chooses 10, 15 or 20 percent of the basic monthly salary; it is deducted every payday
// (shown on the payslip) and the company adds the same amount (payrollEngine / payrollService). Contributions count once
// their payroll is finalized.
// Withdrawal: with 25 years of service (System Settings → retirement.vesting_years) the whole fund — the employee's and
// the company's shares — is paid out. Before that (resigned, terminated or a voluntary withdrawal) only the employee's own
// share is paid and the company share is forfeited. A withdrawal empties the fund and ends the enrollment.
// Journals: approval moves the fund from 2250 Retirement Fund Payable to 2260 Retirement Withdrawals Payable (the forfeited
// company share to 4040); the payout clears 2260 against 1020 Cash in Bank.
import { select, selectOne, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyEmployee, notifyPermission } from "../lib/notify.js";
import { nextDocNo } from "../lib/sequence.js";
import { getSetting } from "../lib/settings.js";
import { toCents, fromCents } from "../lib/money.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { postEntry } from "./journalService.js";
import { fullName } from "./employeeService.js";

export const RATES = [10, 15, 20];
export const REASONS = { retirement: "Retirement (25 years of service)", resigned: "Resigned", terminated: "Terminated", voluntary: "Voluntary withdrawal" };
const manilaToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

/** Completed years of service, two decimals (pure). */
export function tenureYears(hired, until) {
  const a = new Date(`${String(hired).slice(0, 10)}T00:00:00`), b = new Date(`${String(until).slice(0, 10)}T00:00:00`);
  if (b <= a) return 0;
  let years = b.getFullYear() - a.getFullYear();
  const anniversary = new Date(a); anniversary.setFullYear(a.getFullYear() + years);
  if (anniversary > b) { years--; anniversary.setFullYear(anniversary.getFullYear() - 1); }
  const next = new Date(anniversary); next.setFullYear(anniversary.getFullYear() + 1);
  return Math.floor((years + (b - anniversary) / (next - anniversary)) * 100) / 100;
}

/** How a fund splits on withdrawal (pure; centavos). */
export function withdrawalSplit(employeeC, companyC, tenure, vestingYears) {
  const vested = tenure >= vestingYears;
  return { vested, payableC: vested ? employeeC + companyC : employeeC, forfeitedC: vested ? 0 : companyC };
}

// contributions that count: from finalized or released payroll, not yet withdrawn
const BALANCE_SQL = `SELECT COALESCE(SUM(c.employee_share),0) AS ee, COALESCE(SUM(c.company_share),0) AS er, COUNT(*) AS n
  FROM retirement_contributions c JOIN payroll_records r ON r.id = c.payroll_record_id
 WHERE c.employee_id = ? AND c.withdrawal_id IS NULL AND r.status IN ('finalized','released')`;

async function fundOf(employeeId, trx = null) {
  const emp = await selectOne("SELECT id, employee_no, first_name, middle_name, last_name, suffix, date_hired, date_separated, employment_status FROM employees WHERE id = ?", [employeeId], trx);
  if (!emp) throw notFound("Employee not found.");
  const bal = await selectOne(BALANCE_SQL, [employeeId], trx);
  const vestingYears = Number(await getSetting("retirement.vesting_years", 25));
  const tenure = tenureYears(emp.date_hired, emp.date_separated || manilaToday());
  const eeC = toCents(bal.ee), erC = toCents(bal.er);
  const split = withdrawalSplit(eeC, erC, tenure, vestingYears);
  return { emp, eeC, erC, count: Number(bal.n), tenure, vestingYears, ...split };
}

const money = (f) => ({
  employee: fromCents(f.eeC), company: fromCents(f.erC), total: fromCents(f.eeC + f.erC),
  payable: fromCents(f.payableC), forfeited: fromCents(f.forfeitedC),
});

/** My Retirement Fund page. */
export async function myFund(employeeId) {
  const f = await fundOf(employeeId);
  const [enrollment, history, contributions, withdrawals] = await Promise.all([
    selectOne("SELECT * FROM retirement_enrollments WHERE employee_id = ? AND active_flag = 1", [employeeId]),
    select("SELECT * FROM retirement_enrollments WHERE employee_id = ? ORDER BY id DESC LIMIT 10", [employeeId]),
    select(`SELECT c.*, p.label AS period_label, r.status AS payroll_status FROM retirement_contributions c JOIN payroll_records r ON r.id = c.payroll_record_id
              JOIN payroll_periods p ON p.id = c.period_id WHERE c.employee_id = ? ORDER BY c.contribution_date DESC, c.id DESC LIMIT 36`, [employeeId]),
    select("SELECT w.*, u.full_name AS decided_by_name FROM retirement_withdrawals w LEFT JOIN users u ON u.id = w.decided_by WHERE w.employee_id = ? ORDER BY w.id DESC", [employeeId]),
  ]);
  const yearsLeft = Math.max(0, Math.round((f.vestingYears - f.tenure) * 100) / 100);
  return {
    enrollment, history, contributions, withdrawals: withdrawals.map((w) => ({ ...w, reasonLabel: REASONS[w.reason] })),
    fund: { ...money(f), count: f.count, tenure: f.tenure, vestingYears: f.vestingYears, vested: f.vested, yearsLeft,
      vestPct: Math.min(100, Math.round((f.tenure / f.vestingYears) * 100)) },
    pendingWithdrawal: withdrawals.some((w) => w.status === "pending" || w.status === "approved"),
    active: ["active", "on_leave"].includes(f.emp.employment_status), employmentStatus: f.emp.employment_status,
    rates: RATES,
  };
}

export async function enroll(req, employeeId, rate) {
  rate = Number(rate);
  if (!RATES.includes(rate)) throw badRequest("Choose 10%, 15% or 20%.");
  return tx(async (trx) => {
    const emp = await selectOne("SELECT id, employment_status FROM employees WHERE id = ? FOR UPDATE", [employeeId], trx);
    if (!emp || !["active", "on_leave"].includes(emp.employment_status)) throw badRequest(`Only active employees can enroll. Your HR record says ${emp ? emp.employment_status.replace("_", " ") : "no employee record"}; ask HR to correct it if this is wrong.`);
    const pending = await selectOne("SELECT withdrawal_no FROM retirement_withdrawals WHERE employee_id = ? AND status = 'pending'", [employeeId], trx);
    if (pending) throw badRequest(`Withdrawal ${pending.withdrawal_no} is still pending. Enroll again once it is decided.`);
    const cur = await selectOne("SELECT * FROM retirement_enrollments WHERE employee_id = ? AND active_flag = 1 FOR UPDATE", [employeeId], trx);
    if (cur && Number(cur.rate_percent) === rate) throw badRequest(`You already contribute ${rate}%.`);
    if (cur) await exec("UPDATE retirement_enrollments SET status = 'changed', active_flag = NULL, ended_at = NOW() WHERE id = ?", [cur.id], trx);
    const { insertId } = await exec("INSERT INTO retirement_enrollments (employee_id, rate_percent, effective_from, created_by) VALUES (?,?,?,?)", [employeeId, rate, manilaToday(), req.user.id], trx);
    await audit(req, { action: cur ? "retirement_rate_changed" : "retirement_enrolled", module: "payroll", recordType: "retirement_enrollment", recordId: insertId,
      previous: cur ? { rate_percent: cur.rate_percent } : null, next: { rate_percent: rate } }, trx);
    return { changed: !!cur, rate };
  });
}

export async function requestWithdrawal(req, employeeId, reason, remarks, { self = true } = {}) {
  if (!REASONS[reason]) throw badRequest("Choose the reason for the withdrawal.");
  if (self && !["voluntary", "retirement"].includes(reason)) throw badRequest("Choose the reason for the withdrawal.");
  return tx(async (trx) => {
    await selectOne("SELECT id FROM employees WHERE id = ? FOR UPDATE", [employeeId], trx);
    const open = await selectOne("SELECT withdrawal_no FROM retirement_withdrawals WHERE employee_id = ? AND status = 'pending'", [employeeId], trx);
    if (open) throw badRequest(`Withdrawal ${open.withdrawal_no} is already pending.`);
    const f = await fundOf(employeeId, trx);
    if (f.eeC + f.erC <= 0) throw badRequest("There is nothing in the retirement fund to withdraw yet.");
    if (reason === "retirement" && !f.vested) throw badRequest(`Retirement needs ${f.vestingYears} years of service; ${fullName(f.emp)} has ${f.tenure}.`);
    if (["resigned", "terminated"].includes(reason) && f.emp.employment_status !== reason) throw badRequest(`${fullName(f.emp)} is not recorded as ${reason} in the HR record.`);
    const no = await nextDocNo("RFW", 4, trx);
    const { insertId } = await exec(
      `INSERT INTO retirement_withdrawals (withdrawal_no, employee_id, reason, remarks, tenure_years, vested, employee_share, company_share, payable_amount, forfeited_amount, requested_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [no, employeeId, reason, remarks || null, f.tenure, f.vested ? 1 : 0, fromCents(f.eeC), fromCents(f.erC), fromCents(f.payableC), fromCents(f.forfeitedC), req.user.id], trx);
    await audit(req, { action: "retirement_withdrawal_requested", module: "payroll", recordType: "retirement_withdrawal", recordId: insertId,
      next: { withdrawal_no: no, reason, tenure: f.tenure, vested: f.vested, payable: fromCents(f.payableC), forfeited: fromCents(f.forfeitedC) } }, trx);
    await notifyPermission("retirement.approve", { type: "retirement_withdrawal", title: "Retirement fund withdrawal to approve",
      message: `${fullName(f.emp)}: ${REASONS[reason]} — ₱${fromCents(f.payableC)} payable (${no}).`, relatedType: "retirement_withdrawal", relatedId: insertId, link: "/payroll/retirement" }, { excludeUserId: req.user.id }, trx);
    return { no, ...money(f), vested: f.vested };
  });
}

export async function cancelWithdrawal(req, id) {
  const w = await selectOne("SELECT * FROM retirement_withdrawals WHERE id = ?", [id]);
  if (!w || w.employee_id !== req.user.employee_id) throw notFound("Withdrawal not found.");
  if (w.status !== "pending") throw badRequest("Only a pending withdrawal can be cancelled.");
  await exec("UPDATE retirement_withdrawals SET status = 'cancelled' WHERE id = ?", [id]);
  await audit(req, { action: "retirement_withdrawal_cancelled", module: "payroll", recordType: "retirement_withdrawal", recordId: id });
}

export async function decideWithdrawal(req, id, action, remarks) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting.");
  return tx(async (trx) => {
    const w = await selectOne("SELECT * FROM retirement_withdrawals WHERE id = ? FOR UPDATE", [id], trx);
    if (!w) throw notFound("Withdrawal not found.");
    if (w.status !== "pending") throw badRequest(`This withdrawal was already ${w.status}.`);
    if (w.requested_by === req.user.id || (req.user.employee_id && w.employee_id === req.user.employee_id)) throw forbidden("You cannot decide on a withdrawal you filed or your own.");
    if (action === "rejected") {
      await exec("UPDATE retirement_withdrawals SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [req.user.id, remarks, id], trx);
    } else {
      // amounts are taken again now: payroll finalized since the request is included
      const f = await fundOf(w.employee_id, trx);
      if (f.eeC + f.erC <= 0) throw badRequest("The fund is empty.");
      await exec(`UPDATE retirement_contributions c JOIN payroll_records r ON r.id = c.payroll_record_id SET c.withdrawal_id = ?
                   WHERE c.employee_id = ? AND c.withdrawal_id IS NULL AND r.status IN ('finalized','released')`, [id, w.employee_id], trx);
      await exec(`UPDATE retirement_withdrawals SET status = 'approved', decided_by = ?, decided_at = NOW(), decision_remarks = ?, tenure_years = ?, vested = ?,
                    employee_share = ?, company_share = ?, payable_amount = ?, forfeited_amount = ? WHERE id = ?`,
        [req.user.id, remarks || null, f.tenure, f.vested ? 1 : 0, fromCents(f.eeC), fromCents(f.erC), fromCents(f.payableC), fromCents(f.forfeitedC), id], trx);
      await exec("UPDATE retirement_enrollments SET status = 'withdrawn', active_flag = NULL, ended_at = NOW() WHERE employee_id = ? AND active_flag = 1", [w.employee_id], trx);
      await postEntry({ req, date: manilaToday(), description: `Retirement fund withdrawal ${w.withdrawal_no} (${fullName(f.emp)})`, sourceType: "retirement_withdrawal", sourceId: id, sourceEvent: "approval",
        lines: [
          { account: "2250", debit: f.eeC + f.erC, description: "Retirement fund released" },
          { account: "2260", credit: f.payableC, description: f.vested ? "Payable: employee and company shares" : "Payable: employee share" },
          { account: "4040", credit: f.forfeitedC, description: "Company share forfeited (service under the vesting period)" },
        ] }, trx);
    }
    await audit(req, { action: `retirement_withdrawal_${action}`, module: "payroll", recordType: "retirement_withdrawal", recordId: id, decision: action, remarks }, trx);
    await notifyEmployee(w.employee_id, {
      type: `retirement_withdrawal_${action}`, title: action === "approved" ? "Retirement fund withdrawal approved" : "Retirement fund withdrawal rejected",
      message: action === "approved" ? `${w.withdrawal_no} was approved. Payroll will release the payout.` : `${w.withdrawal_no} was rejected: ${remarks}`,
      relatedType: "retirement_withdrawal", relatedId: id, link: "/my/retirement",
    }, trx);
    return w;
  });
}

export async function markPaid(req, id, reference) {
  reference = String(reference || "").trim().slice(0, 100);
  if (!reference) throw badRequest("Enter the payment reference (check or transfer number).");
  return tx(async (trx) => {
    const w = await selectOne("SELECT * FROM retirement_withdrawals WHERE id = ? FOR UPDATE", [id], trx);
    if (!w) throw notFound("Withdrawal not found.");
    if (w.status !== "approved") throw badRequest("Only an approved withdrawal can be paid.");
    await exec("UPDATE retirement_withdrawals SET status = 'paid', paid_by = ?, paid_at = NOW(), payment_reference = ? WHERE id = ?", [req.user.id, reference, id], trx);
    await postEntry({ req, date: manilaToday(), description: `Retirement fund payout ${w.withdrawal_no} (${reference})`, sourceType: "retirement_withdrawal", sourceId: id, sourceEvent: "payout",
      lines: [{ account: "2260", debit: toCents(w.payable_amount), description: "Withdrawal paid" }, { account: "1020", credit: toCents(w.payable_amount), description: `Payment ${reference}` }] }, trx);
    await audit(req, { action: "retirement_withdrawal_paid", module: "payroll", recordType: "retirement_withdrawal", recordId: id, next: { reference, amount: w.payable_amount } }, trx);
    await notifyEmployee(w.employee_id, { type: "retirement_withdrawal_paid", title: "Retirement fund paid out", message: `₱${w.payable_amount} was released (${reference}).`, relatedType: "retirement_withdrawal", relatedId: id, link: "/my/retirement" }, trx);
  });
}

/** Payroll Staff / Accounting Supervisor page. */
export async function overview() {
  const members = await select(
    `SELECT e.id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, e.date_hired, e.date_separated, e.employment_status, d.name AS department,
            en.rate_percent, en.effective_from,
            COALESCE(SUM(IF(c.withdrawal_id IS NULL AND r.status IN ('finalized','released'), c.employee_share, 0)),0) AS ee,
            COALESCE(SUM(IF(c.withdrawal_id IS NULL AND r.status IN ('finalized','released'), c.company_share, 0)),0) AS er
       FROM employees e JOIN departments d ON d.id = e.department_id
       LEFT JOIN retirement_enrollments en ON en.employee_id = e.id AND en.active_flag = 1
       LEFT JOIN retirement_contributions c ON c.employee_id = e.id LEFT JOIN payroll_records r ON r.id = c.payroll_record_id
      WHERE e.deleted_at IS NULL
      GROUP BY e.id, en.id HAVING en.rate_percent IS NOT NULL OR ee > 0 OR er > 0
      ORDER BY e.last_name, e.first_name`);
  const vestingYears = Number(await getSetting("retirement.vesting_years", 25));
  const withdrawals = await select(
    `SELECT w.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, u.full_name AS requested_by_name, x.full_name AS decided_by_name
       FROM retirement_withdrawals w JOIN employees e ON e.id = w.employee_id JOIN users u ON u.id = w.requested_by LEFT JOIN users x ON x.id = w.decided_by
      ORDER BY FIELD(w.status, 'pending', 'approved', 'paid', 'rejected', 'cancelled'), w.id DESC LIMIT 100`);
  const separated = await select(
    `SELECT DISTINCT e.id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, e.employment_status FROM employees e
       JOIN retirement_contributions c ON c.employee_id = e.id AND c.withdrawal_id IS NULL
      WHERE e.employment_status IN ('resigned','terminated') ORDER BY e.last_name`);
  const rows = members.map((m) => {
    const tenure = tenureYears(m.date_hired, m.date_separated || manilaToday());
    const s = withdrawalSplit(toCents(m.ee), toCents(m.er), tenure, vestingYears);
    return { ...m, name: fullName(m), tenure, vested: s.vested, total: fromCents(toCents(m.ee) + toCents(m.er)), withdrawable: fromCents(s.payableC) };
  });
  const sum = (k) => fromCents(rows.reduce((a, r) => a + toCents(r[k]), 0));
  return {
    rows, vestingYears, separated: separated.map((s) => ({ ...s, name: fullName(s) })),
    withdrawals: withdrawals.map((w) => ({ ...w, name: fullName(w), reasonLabel: REASONS[w.reason] })),
    totals: { enrolled: rows.filter((r) => r.rate_percent).length, ee: sum("ee"), er: sum("er"), total: sum("total") },
  };
}
