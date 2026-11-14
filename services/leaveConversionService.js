// Vacation leave cash conversion. Every employee gets 10 days of vacation leave a year; the credits reset to 10 every
// 1 January (balances are per year and unused days do not carry over). Whatever is left of a year's vacation leave can be
// converted to cash at year end: the employee requests it from 1 December to 31 January, the Accounting Supervisor
// approves, and the amount (days × daily rate) is paid as a non-taxable earning in the next payroll computed.
// The requested days are reserved at once (pending), so they cannot also be used as leave.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyEmployee, notifyPermission } from "../lib/notify.js";
import { nextDocNo } from "../lib/sequence.js";
import { getSetting } from "../lib/settings.js";
import { toCents, fromCents } from "../lib/money.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { ensureBalances, remainingOf } from "./leaveService.js";
import { fullName } from "./employeeService.js";
import { routeFor, sendToDepartment, guardRouting, reportOutcome } from "./requestRouting.js";
import { startApproval } from "./supervisorApproval.js";

const manilaToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

/** The year whose vacation leave can be converted today, or null outside the window (1 Dec – 31 Jan). Pure. */
export function conversionYear(today = manilaToday()) {
  const [y, m] = today.split("-").map(Number);
  if (m === 12) return y;
  if (m === 1) return y - 1;
  return null;
}

/** Daily rate in centavos from the salary in force on `date` (same method as the payroll engine). */
export async function dailyRateC(employeeId, date, trx = null) {
  const e = await selectOne("SELECT basic_salary, rate_basis FROM employees WHERE id = ?", [employeeId], trx);
  const h = await selectOne(
    `SELECT new_amount, rate_basis FROM salary_history WHERE employee_id = ? AND verification_status <> 'rejected' AND effective_date <= ?
      ORDER BY effective_date DESC, id DESC LIMIT 1`, [employeeId, date], trx);
  const rate = toCents(h ? h.new_amount : e.basic_salary), basis = h ? h.rate_basis : e.rate_basis;
  const dpy = Number(await getSetting("payroll.days_per_year", 261)), hpd = Number(await getSetting("attendance.hours_per_day", 8));
  if (basis === "monthly") return Math.round((rate * 12) / dpy);
  if (basis === "hourly") return Math.round(rate * hpd);
  return rate;
}

async function vlBalance(employeeId, year, trx = null, lock = false) {
  await ensureBalances(employeeId, year, trx);
  return selectOne(
    `SELECT b.*, t.name, t.code FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
      WHERE b.employee_id = ? AND b.year = ? AND t.convertible_to_cash = 1 AND t.is_active = 1 LIMIT 1 ${lock ? "FOR UPDATE" : ""}`, [employeeId, year], trx);
}

/** What the employee sees on My Leave. */
export async function myConversion(employeeId) {
  const year = conversionYear();
  const history = await select(
    `SELECT c.*, t.name AS type_name, u.full_name AS decided_by_name FROM leave_conversions c JOIN leave_types t ON t.id = c.leave_type_id
       LEFT JOIN users u ON u.id = c.decided_by WHERE c.employee_id = ? ORDER BY c.year DESC, c.id DESC LIMIT 10`, [employeeId]);
  let offer = null;
  if (year) {
    const b = await vlBalance(employeeId, year);
    const active = history.find((h) => h.year === year && ["pending", "approved", "paid"].includes(h.status));
    if (b && !active) {
      const days = Math.max(0, remainingOf(b));
      const rate = await dailyRateC(employeeId, manilaToday());
      offer = { year, days, type: b.name, dailyRate: fromCents(rate), amount: fromCents(Math.round(days * rate)) };
    }
  }
  return { year, offer, history };
}

export async function requestConversion(req) {
  const employeeId = req.user.employee_id;
  const year = conversionYear();
  if (!year) throw badRequest("Vacation leave can be converted to cash from 1 December to 31 January only.");
  return tx(async (trx) => {
    const b = await vlBalance(employeeId, year, trx, true);
    if (!b) throw badRequest("You have no vacation leave that can be converted.");
    const days = Math.round(remainingOf(b) * 10) / 10;
    if (days <= 0) throw badRequest(`You have no unused vacation leave left for ${year}.`);
    const rate = await dailyRateC(employeeId, manilaToday(), trx);
    const amount = Math.round(days * rate);
    const no = await nextDocNo("VLC", 4, trx);
    const { emp, routed, approver } = await routeFor(employeeId, trx);
    const { insertId } = await exec(
      `INSERT INTO leave_conversions (conversion_no, employee_id, leave_type_id, year, days, daily_rate, amount, requested_by, routed_to) VALUES (?,?,?,?,?,?,?,?,?)`,
      [no, employeeId, b.leave_type_id, year, days, fromCents(rate), fromCents(amount), req.user.id, routed], trx);
    // the immediate supervisor approves first; Accounting/Payroll give the final approval
    await startApproval("leave_conversion", insertId, approver, req, trx);
    if (routed === "department") await sendToDepartment("leave_conversion", { no }, emp, { year, days, amount: fromCents(amount) }, trx);
    await exec("UPDATE leave_balances SET pending_days = pending_days + ? WHERE id = ?", [days, b.id], trx);
    await audit(req, { action: "leave_conversion_requested", module: "leave", recordType: "leave_conversion", recordId: insertId, next: { conversion_no: no, year, days, amount: fromCents(amount) } }, trx);
    return { no, days, amount: fromCents(amount), year };
  });
}

async function release(c, trx) {
  await exec(
    `UPDATE leave_balances SET pending_days = GREATEST(pending_days - ?, 0) WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
    [c.days, c.employee_id, c.leave_type_id, c.year], trx);
}

export async function cancelConversion(req, id) {
  return tx(async (trx) => {
    const c = await selectOne("SELECT * FROM leave_conversions WHERE id = ? FOR UPDATE", [id], trx);
    if (!c || c.employee_id !== req.user.employee_id) throw notFound("Conversion request not found.");
    if (c.status !== "pending") throw badRequest("Only a pending request can be cancelled.");
    await release(c, trx);
    await exec("UPDATE leave_conversions SET status = 'cancelled', active_flag = NULL WHERE id = ?", [id], trx);
    await audit(req, { action: "leave_conversion_cancelled", module: "leave", recordType: "leave_conversion", recordId: id }, trx);
  });
}

export async function listConversions(status = "pending") {
  const st = ["pending", "approved", "paid", "rejected", "cancelled", "all"].includes(status) ? status : "pending";
  const rows = await select(
    `SELECT c.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department, u.full_name AS decided_by_name
       FROM leave_conversions c JOIN employees e ON e.id = c.employee_id JOIN departments d ON d.id = e.department_id LEFT JOIN users u ON u.id = c.decided_by
      ${st === "all" ? "" : "WHERE c.status = ?"} ORDER BY c.requested_at DESC LIMIT 200`, st === "all" ? [] : [st]);
  const counts = await select("SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM leave_conversions GROUP BY status");
  return { status: st, rows: rows.map((r) => ({ ...r, name: fullName(r) })), counts: Object.fromEntries(counts.map((c) => [c.status, c])) };
}

export async function decideConversion(req, id, action, remarks, opts = {}) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting.");
  return tx(async (trx) => {
    const c = await selectOne("SELECT * FROM leave_conversions WHERE id = ? FOR UPDATE", [id], trx);
    if (!c) throw notFound("Conversion request not found.");
    if (c.status !== "pending") throw badRequest(`This request was already ${c.status}.`);
    if ((req.user.id && c.requested_by === req.user.id) || (req.user.employee_id && c.employee_id === req.user.employee_id)) throw forbidden("You cannot decide on your own conversion request.");
    guardRouting(c, req, opts);
    await release(c, trx);
    if (action === "approved") {
      await exec("UPDATE leave_balances SET used_days = used_days + ? WHERE employee_id = ? AND leave_type_id = ? AND year = ?", [c.days, c.employee_id, c.leave_type_id, c.year], trx);
      await exec("UPDATE leave_conversions SET status = 'approved', decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [req.user.id ?? null, remarks || null, id], trx);
    } else {
      await exec("UPDATE leave_conversions SET status = 'rejected', active_flag = NULL, decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [req.user.id ?? null, remarks, id], trx);
    }
    await reportOutcome("leave_conversion", c, action, req, trx);
    await audit(req, { action: `leave_conversion_${action}`, module: "leave", recordType: "leave_conversion", recordId: id, decision: action, remarks, next: { conversion_no: c.conversion_no, days: c.days, amount: c.amount } }, trx);
    await notifyEmployee(c.employee_id, {
      type: `leave_conversion_${action}`, title: action === "approved" ? "Vacation leave conversion approved" : "Vacation leave conversion rejected",
      message: action === "approved" ? `${c.conversion_no}: ₱${c.amount} for ${c.days} day(s) will be paid in your next payroll.` : `${c.conversion_no} was rejected: ${remarks}`,
      relatedType: "leave_conversion", relatedId: id, link: "/my/leave",
    }, trx);
    return c;
  });
}

export const pendingConversions = () => scalar("SELECT COUNT(*) FROM leave_conversions WHERE status = 'pending'").then(Number);
