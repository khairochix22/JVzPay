// Leave (Module 5) — employee side: credits, applications, cancellation.
// Days requested are RESERVED (pending_days) at submission so two applications can't spend the same credits.
// Supervisor review, balance adjustments, the leave calendar and attendance posting are delivered in Phase 5.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyPermission } from "../lib/notify.js";
import { nextDocNo } from "../lib/sequence.js";
import { getSetting } from "../lib/settings.js";
import { validate } from "../lib/validate.js";
import { routeFor, sendToDepartment, guardRouting, reportOutcome } from "./requestRouting.js";
import { startApproval } from "./supervisorApproval.js";
import { badRequest, notFound } from "../lib/errors.js";
import { saveAttachment } from "../middleware/upload.js";
import { daysOffBetween } from "./scheduleService.js";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const todayIso = () => iso(new Date());

// Credits default to each active leave type's annual entitlement (idempotent; never overwrites existing rows).
export async function ensureBalances(employeeId, year, trx = null) {
  await exec(
    `INSERT IGNORE INTO leave_balances (employee_id, leave_type_id, year, entitled_days)
     SELECT ?, id, ?, annual_entitlement_days FROM leave_types WHERE is_active = 1`,
    [employeeId, year], trx);
}

export const remainingOf = (b) => Number(b.entitled_days) + Number(b.adjusted_days) - Number(b.used_days) - Number(b.pending_days);

export async function balances(employeeId, year) {
  await ensureBalances(employeeId, year);
  const rows = await select(
    `SELECT b.*, t.code, t.name, t.is_paid, t.allow_negative_balance, t.requires_attachment, t.attachment_after_days
       FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
      WHERE b.employee_id = ? AND b.year = ? AND t.is_active = 1 ORDER BY t.name`, [employeeId, year]);
  return rows.map((b) => {
    const total = Number(b.entitled_days) + Number(b.adjusted_days);
    return { ...b, total, remaining: remainingOf(b), pct: total ? Math.max(0, Math.min(100, Math.round((remainingOf(b) / total) * 100))) : 0 };
  });
}

/** Working days in [start, end], excluding the employee's two days off and active non-working holidays. */
export async function countLeaveDays(start, end, halfDay, employeeId) {
  const off = await daysOffBetween(employeeId, start, end);
  const hol = await select(
    "SELECT holiday_date FROM holidays WHERE is_active = 1 AND holiday_type IN ('regular','special_non_working') AND holiday_date BETWEEN ? AND ?",
    [start, end]);
  const holidays = new Set(hol.map((h) => h.holiday_date));
  let n = 0;
  for (let d = parseDate(start); d <= parseDate(end); d.setDate(d.getDate() + 1)) {
    if (!off.has(iso(d)) && !holidays.has(iso(d))) n++;
  }
  if (halfDay) return n === 1 ? 0.5 : n; // half-day only applies to single-day leave
  return n;
}

export function validateApplication(body) {
  const { values, errors } = validate(body, {
    leave_type_id: { label: "Leave type", type: "id", required: true },
    start_date: { label: "Start date", type: "date", required: true },
    end_date: { label: "End date", type: "date", required: true },
    half_day: { label: "Half day", type: "bool" },
    reason: { label: "Reason", required: true, max: 500, min: 5 },
  });
  if (!errors.start_date && !errors.end_date) {
    if (values.end_date < values.start_date) errors.end_date = "End date cannot be before the start date.";
    if (values.start_date.slice(0, 4) !== values.end_date.slice(0, 4)) errors.end_date = "A leave application cannot span two calendar years. File one per year.";
    const earliest = new Date(); earliest.setDate(earliest.getDate() - 30);
    const latest = new Date(); latest.setFullYear(latest.getFullYear() + 1);
    if (values.start_date < iso(earliest)) errors.start_date = "Leave can be filed at most 30 days after it was taken.";
    if (values.end_date > iso(latest)) errors.end_date = "Leave can be filed at most one year in advance.";
    if (values.half_day && values.start_date !== values.end_date) errors.half_day = "Half-day leave must start and end on the same day.";
  }
  return { values, errors };
}

export async function apply(req, values, file) {
  const employeeId = req.user.employee_id;
  const type = await selectOne("SELECT * FROM leave_types WHERE id = ? AND is_active = 1", [values.leave_type_id]);
  if (!type) throw badRequest("Select a valid leave type.");
  const days = await countLeaveDays(values.start_date, values.end_date, values.half_day, employeeId);
  if (days <= 0) throw badRequest("The selected dates fall entirely on rest days or holidays.");
  const needsAttachment = !!type.requires_attachment && (type.attachment_after_days === null || days > Number(type.attachment_after_days));
  if (needsAttachment && !file) {
    throw badRequest(`${type.name} of ${days} day(s) requires a supporting document${type.attachment_after_days !== null ? ` (more than ${Number(type.attachment_after_days)} days)` : ""}.`);
  }
  const year = Number(values.start_date.slice(0, 4));

  return tx(async (trx) => {
    await ensureBalances(employeeId, year, trx);
    const bal = await selectOne("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ? FOR UPDATE", [employeeId, type.id, year], trx);
    const overlap = await scalar(
      "SELECT COUNT(*) FROM leave_applications WHERE employee_id = ? AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ?",
      [employeeId, values.end_date, values.start_date], trx);
    if (Number(overlap)) throw badRequest("You already have a pending or approved leave that overlaps these dates.");
    if (!type.allow_negative_balance && remainingOf(bal) < days) {
      throw badRequest(`Not enough ${type.name} credits: ${remainingOf(bal)} day(s) available, ${days} requested.`);
    }
    const no = await nextDocNo("LV", 4, trx);
    const { emp, routed, approver } = await routeFor(employeeId, trx);
    const { insertId } = await exec(
      `INSERT INTO leave_applications (application_no, employee_id, leave_type_id, start_date, end_date, days, reason, submitted_by, routed_to)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [no, employeeId, type.id, values.start_date, values.end_date, days, values.reason, req.user.id, routed], trx);
    const docId = await saveAttachment(req, file, "leave_application", insertId, trx);
    if (docId) await exec("UPDATE leave_applications SET attachment_id = ? WHERE id = ?", [docId, insertId], trx);
    await exec("UPDATE leave_balances SET pending_days = pending_days + ? WHERE id = ?", [days, bal.id], trx);
    await startApproval("leave", insertId, approver, req, trx);
    await audit(req, { action: "leave_submitted", module: "leave", recordType: "leave_application", recordId: insertId,
      next: { application_no: no, type: type.code, start: values.start_date, end: values.end_date, days } }, trx);
    // other departments' requests go to their own supervisor through HR; Payroll/Accounting's to the Accounting Supervisor
    if (routed === "department") {
      await sendToDepartment("leave", { no }, emp, { leave_type: type.code, leave_type_name: type.name, start_date: values.start_date, end_date: values.end_date, days, reason: values.reason }, trx);
      return { id: insertId, no, days, routed };
    }
    return { id: insertId, no, days, routed, approver: approver.name };
  });
}

export async function cancel(req, id) {
  return tx(async (trx) => {
    const a = await selectOne("SELECT * FROM leave_applications WHERE id = ? FOR UPDATE", [id], trx);
    if (!a || a.employee_id !== req.user.employee_id) throw notFound("Leave application not found.");
    if (a.status !== "pending") throw badRequest("Only pending applications can be cancelled.");
    await exec("UPDATE leave_applications SET status = 'cancelled' WHERE id = ?", [id], trx);
    await exec(
      "UPDATE leave_balances SET pending_days = GREATEST(pending_days - ?, 0) WHERE employee_id = ? AND leave_type_id = ? AND year = ?",
      [a.days, a.employee_id, a.leave_type_id, Number(String(a.start_date).slice(0, 4))], trx);
    await audit(req, { action: "leave_cancelled", module: "leave", recordType: "leave_application", recordId: id, remarks: a.application_no }, trx);
  });
}

export async function myApplications(employeeId) {
  return select(
    `SELECT a.*, t.name AS type_name, u.full_name AS decided_by_name, doc.original_name AS attachment_name
       FROM leave_applications a JOIN leave_types t ON t.id = a.leave_type_id
       LEFT JOIN users u ON u.id = a.decided_by LEFT JOIN document_attachments doc ON doc.id = a.attachment_id
      WHERE a.employee_id = ? ORDER BY a.start_date DESC, a.id DESC LIMIT 50`, [employeeId]);
}

export const activeTypes = () => select("SELECT id, code, name, is_paid, requires_attachment, attachment_after_days, allow_negative_balance FROM leave_types WHERE is_active = 1 ORDER BY name");
