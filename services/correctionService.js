// Attendance (Module 4) — employee side: own records and correction requests.
// Employee submits → request stores ORIGINAL + requested values → (Phase 5) supervisor decides → approved values update
// attendance → audit. Employees can never edit attendance directly, and records locked by finalized payroll can't be corrected here.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyPermission } from "../lib/notify.js";
import { routeFor, guardRouting, reportOutcome } from "./requestRouting.js";
import { startApproval } from "./supervisorApproval.js";

import { nextDocNo } from "../lib/sequence.js";
import { validate } from "../lib/validate.js";
import { badRequest, notFound } from "../lib/errors.js";
import { saveAttachment } from "../middleware/upload.js";
import { todayIso } from "./leaveService.js";

export const REQUESTABLE_STATUSES = ["present", "late", "half_day", "absent", "on_leave"];

export function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  const now = new Date();
  const y = m ? Number(m[1]) : now.getFullYear();
  const mo = m ? Number(m[2]) : now.getMonth() + 1;
  const start = `${y}-${String(mo).padStart(2, "0")}-01`;
  const last = new Date(y, mo, 0).getDate();
  const prev = new Date(y, mo - 2, 1), next = new Date(y, mo, 1);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return {
    ym: `${y}-${String(mo).padStart(2, "0")}`, start, end: `${y}-${String(mo).padStart(2, "0")}-${last}`,
    label: new Date(y, mo - 1, 1).toLocaleDateString("en-PH", { month: "long", year: "numeric" }),
    prev: fmt(prev), next: fmt(next) <= fmt(now) ? fmt(next) : null,
  };
}

export async function myAttendance(employeeId, ym) {
  const range = monthRange(ym);
  const [records, corrections, overtime] = await Promise.all([
    select(
      `SELECT a.*, (SELECT r.status FROM attendance_correction_requests r WHERE r.employee_id = a.employee_id AND r.work_date = a.work_date AND r.status = 'pending' LIMIT 1) AS pending_correction
         FROM attendance_records a WHERE a.employee_id = ? AND a.work_date BETWEEN ? AND ? ORDER BY a.work_date`,
      [employeeId, range.start, range.end]),
    select(
      `SELECT r.*, u.full_name AS decided_by_name FROM attendance_correction_requests r LEFT JOIN users u ON u.id = r.decided_by
        WHERE r.employee_id = ? ORDER BY r.id DESC LIMIT 20`, [employeeId]),
    select("SELECT work_date, hours, ot_type, status FROM overtime_records WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status = 'approved' ORDER BY work_date", [employeeId, range.start, range.end]),
  ]);
  const count = (s) => records.filter((r) => r.status === s).length;
  const summary = {
    present: count("present"), late: count("late"), absent: count("absent"), on_leave: count("on_leave"), half_day: count("half_day"),
    lateMinutes: records.reduce((s, r) => s + Number(r.late_minutes), 0),
    undertimeMinutes: records.reduce((s, r) => s + Number(r.undertime_minutes), 0),
    overtimeHours: overtime.reduce((s, o) => s + Number(o.hours), 0),
  };
  return { range, records, corrections, overtime, summary };
}

export function validateCorrection(body) {
  const { values, errors } = validate(body, {
    work_date: { label: "Date", type: "date", required: true },
    requested_status: { label: "Correct status", type: "enum", values: REQUESTABLE_STATUSES, required: true },
    requested_time_in: { label: "Time in", pattern: /^([01]\d|2[0-3]):[0-5]\d$/, patternMessage: "Enter a valid time (HH:MM)." },
    requested_time_out: { label: "Time out", pattern: /^([01]\d|2[0-3]):[0-5]\d$/, patternMessage: "Enter a valid time (HH:MM)." },
    reason: { label: "Reason", required: true, min: 10, max: 500 },
  });
  if (!errors.work_date) {
    const earliest = new Date(); earliest.setDate(earliest.getDate() - 60);
    const e = `${earliest.getFullYear()}-${String(earliest.getMonth() + 1).padStart(2, "0")}-${String(earliest.getDate()).padStart(2, "0")}`;
    if (values.work_date > todayIso()) errors.work_date = "You cannot request a correction for a future date.";
    else if (values.work_date < e) errors.work_date = "Corrections can be requested for the last 60 days only.";
  }
  const worked = ["present", "late", "half_day"].includes(values.requested_status);
  if (worked) {
    if (!values.requested_time_in && !errors.requested_time_in) errors.requested_time_in = "Time in is required for this status.";
    if (!values.requested_time_out && !errors.requested_time_out) errors.requested_time_out = "Time out is required for this status.";
    if (values.requested_time_in && values.requested_time_out && values.requested_time_out <= values.requested_time_in) {
      errors.requested_time_out = "Time out must be later than time in (overnight shifts are not supported).";
    }
  } else {
    values.requested_time_in = null;
    values.requested_time_out = null;
  }
  return { values, errors };
}

export async function requestCorrection(req, values, file) {
  const employeeId = req.user.employee_id;
  return tx(async (trx) => {
    await exec("SELECT id FROM employees WHERE id = ? FOR UPDATE", [employeeId], trx);
    const rec = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ?", [employeeId, values.work_date], trx);
    if (rec?.validation_status === "locked") {
      throw badRequest("This day is already included in finalized payroll. Ask Payroll Staff to file a payroll adjustment instead.");
    }
    if (Number(await scalar("SELECT COUNT(*) FROM attendance_correction_requests WHERE employee_id = ? AND work_date = ? AND status = 'pending'", [employeeId, values.work_date], trx))) {
      throw badRequest("You already have a pending correction request for this date.");
    }
    const no = await nextDocNo("ACR", 4, trx);
    const { emp, routed, approver } = await routeFor(employeeId, trx);
    const { insertId } = await exec(
      `INSERT INTO attendance_correction_requests
         (request_no, employee_id, attendance_id, work_date, original_time_in, original_time_out, original_status,
          requested_time_in, requested_time_out, requested_status, reason, submitted_by, routed_to)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [no, employeeId, rec?.id ?? null, values.work_date, rec?.time_in ?? null, rec?.time_out ?? null, rec?.status ?? null,
       values.requested_time_in, values.requested_time_out, values.requested_status, values.reason, req.user.id, routed], trx);
    const docId = await saveAttachment(req, file, "attendance_correction_request", insertId, trx);
    if (docId) await exec("UPDATE attendance_correction_requests SET attachment_id = ? WHERE id = ?", [docId, insertId], trx);
    await startApproval("attendance_correction", insertId, approver, req, trx);
    await audit(req, {
      action: "attendance_correction_submitted", module: "attendance", recordType: "attendance_correction_request", recordId: insertId,
      previous: rec ? { status: rec.status, time_in: rec.time_in, time_out: rec.time_out } : { record: "none" },
      next: { request_no: no, date: values.work_date, status: values.requested_status, time_in: values.requested_time_in, time_out: values.requested_time_out },
    }, trx);
    return { id: insertId, no, approver: approver.name || null };
  });
}

export async function cancelCorrection(req, id) {
  return tx(async (trx) => {
    const r = await selectOne("SELECT * FROM attendance_correction_requests WHERE id = ? FOR UPDATE", [id], trx);
    if (!r || r.employee_id !== req.user.employee_id) throw notFound("Request not found.");
    if (r.status !== "pending") throw badRequest("Only pending requests can be cancelled.");
    await exec("UPDATE attendance_correction_requests SET status = 'cancelled' WHERE id = ?", [id], trx);
    await audit(req, { action: "attendance_correction_cancelled", module: "attendance", recordType: "attendance_correction_request", recordId: id, remarks: r.request_no }, trx);
  });
}
