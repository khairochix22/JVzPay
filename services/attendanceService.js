// Attendance (Module 4) — staff/supervisor side: daily computation, encoding, validation, correction decisions.
// Rules: only VALIDATED attendance feeds payroll; records locked by finalized payroll can never change here;
// every change keeps the previous values in the audit trail.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { guardRouting, reportOutcome } from "./requestRouting.js";
import { audit } from "../lib/audit.js";
import { notifyEmployee } from "../lib/notify.js";
import { getSetting } from "../lib/settings.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { fullName } from "./employeeService.js";
import { scheduleFor, isDayOff } from "./scheduleService.js";

export const STATUSES = ["present", "late", "half_day", "absent", "on_leave", "holiday", "rest_day"];
const WORKED = ["present", "late", "half_day"];

const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function schedule() {
  return {
    start: toMin(await getSetting("attendance.work_start", "08:00")),
    end: toMin(await getSetting("attendance.work_end", "17:00")),
    breakMin: Number(await getSetting("attendance.break_minutes", 60)),
    grace: Number(await getSetting("attendance.grace_minutes", 10)),
    hoursPerDay: Number(await getSetting("attendance.hours_per_day", 8)),
    restDay: Number(await getSetting("attendance.rest_day", 0)),
  };
}

/**
 * Pure computation of one day's attendance figures (exported for unit tests).
 * Lateness beyond the grace period counts in full from shift start; undertime counts from shift end;
 * a 1-hour unpaid break is deducted from days longer than 5 hours; regular hours are capped at the standard day
 * (anything beyond is overtime and is paid only through an approved overtime record).
 */
export function computeDay({ status, time_in, time_out }, cfg) {
  const zero = { status, time_in: null, time_out: null, late_minutes: 0, undertime_minutes: 0, hours_worked: 0 };
  if (["absent", "on_leave"].includes(status)) return zero;
  const tin = toMin(time_in), tout = toMin(time_out);
  if (["holiday", "rest_day"].includes(status) && (tin === null || tout === null)) return zero;
  if (tin === null || tout === null) throw badRequest("Time in and time out are required for this status.");
  if (tout <= tin) throw badRequest("Time out must be later than time in.");
  let worked = tout - tin;
  if (worked > 300) worked -= cfg.breakMin;
  const hours = Math.round(Math.min(worked / 60, cfg.hoursPerDay) * 100) / 100;
  if (!WORKED.includes(status)) return { status, time_in, time_out, late_minutes: 0, undertime_minutes: 0, hours_worked: hours };
  const lateRaw = tin - cfg.start;
  const late = lateRaw > cfg.grace ? lateRaw : 0;
  const undertime = status === "half_day" ? 0 : Math.max(0, cfg.end - tout);
  const finalStatus = status === "half_day" ? "half_day" : late > 0 ? "late" : "present";
  return { status: finalStatus, time_in, time_out, late_minutes: late, undertime_minutes: undertime, hours_worked: hours };
}

// ---- list ---------------------------------------------------------------------------------------------------------------
export function dateRange(req, defaultDays = 14) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  const to = ok(req.query.to) ? req.query.to : iso(new Date());
  const fromD = new Date(); fromD.setDate(fromD.getDate() - (defaultDays - 1));
  const from = ok(req.query.from) ? req.query.from : iso(fromD);
  return from <= to ? { from, to } : { from: to, to: from };
}

export async function listRecords(req) {
  const t = tableState(req, { sortable: { date: "a.work_date", employee: "e.last_name", status: "a.status" }, defaultSort: "date", defaultDir: "desc", perPage: 25 });
  const { from, to } = dateRange(req);
  const where = ["a.work_date BETWEEN ? AND ?"];
  const params = [from, to];
  const department = /^\d+$/.test(req.query.department || "") ? Number(req.query.department) : null;
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const validation = ["pending", "validated", "locked"].includes(req.query.validation) ? req.query.validation : null;
  if (department) { where.push("e.department_id = ?"); params.push(department); }
  if (status) { where.push("a.status = ?"); params.push(status); }
  if (validation) { where.push("a.validation_status = ?"); params.push(validation); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.join(" AND ");
  const total = Number(await scalar(`SELECT COUNT(*) FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE ${W}`, params));
  const rows = await select(
    `SELECT a.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department, v.full_name AS validated_by_name
       FROM attendance_records a JOIN employees e ON e.id = a.employee_id JOIN departments d ON d.id = e.department_id
       LEFT JOIN users v ON v.id = a.validated_by
      WHERE ${W} ORDER BY ${t.orderBy}, e.last_name LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  const summary = await selectOne(
    `SELECT COUNT(*) AS total, COALESCE(SUM(a.status = 'present'),0) AS present, COALESCE(SUM(a.status = 'late'),0) AS late,
            COALESCE(SUM(a.status = 'absent'),0) AS absent, COALESCE(SUM(a.status = 'on_leave'),0) AS on_leave,
            COALESCE(SUM(a.validation_status = 'pending'),0) AS pending, COALESCE(SUM(a.late_minutes),0) AS late_minutes
       FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE ${W}`, params);
  return {
    rows: rows.map((r) => ({ ...r, name: fullName(r) })), t, from, to, summary,
    filters: { department, status, validation },
    meta: tableMeta(req, t, total, { from, to, department: department || undefined, status: status || undefined, validation: validation || undefined }),
  };
}

// ---- encoding sheet ---------------------------------------------------------------------------------------------------------
export async function sheet(date, departmentId = null) {
  const cfg = await schedule();
  const holiday = await selectOne("SELECT name, holiday_type FROM holidays WHERE holiday_date = ? AND is_active = 1", [date]);
  const emps = await select(
    `SELECT e.id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department, p.title AS position,
            a.id AS record_id, a.status, a.time_in, a.time_out, a.validation_status, a.remarks, a.late_minutes, a.undertime_minutes, a.hours_worked,
            (SELECT t.name FROM leave_applications l JOIN leave_types t ON t.id = l.leave_type_id
              WHERE l.employee_id = e.id AND l.status = 'approved' AND ? BETWEEN l.start_date AND l.end_date LIMIT 1) AS leave_name
       FROM employees e JOIN departments d ON d.id = e.department_id JOIN positions p ON p.id = e.position_id
       LEFT JOIN attendance_records a ON a.employee_id = e.id AND a.work_date = ?
      WHERE e.deleted_at IS NULL AND e.date_hired <= ? AND (e.date_separated IS NULL OR e.date_separated >= ?)
        AND e.employment_status IN ('active','on_leave') ${departmentId ? "AND e.department_id = ?" : ""}
      ORDER BY d.name, e.last_name, e.first_name`,
    departmentId ? [date, date, date, date, departmentId] : [date, date, date, date]);
  // each employee has their own two days off
  const offIds = new Set();
  for (const e of emps) if (isDayOff(await scheduleFor(e.id, date))) offIds.add(e.id);
  const isRestDay = emps.length > 0 && offIds.size === emps.length;
  const suggestFor = (e) => (holiday ? "holiday" : offIds.has(e.id) ? "rest_day" : "");
  return {
    holiday, isRestDay, cfg,
    shiftStart: await getSetting("attendance.work_start", "08:00"), shiftEnd: await getSetting("attendance.work_end", "17:00"),
    rows: emps.map((e) => ({
      ...e, name: fullName(e),
      dayOff: offIds.has(e.id),
      value: { status: e.status || (e.leave_name ? "on_leave" : suggestFor(e)), time_in: e.time_in ? e.time_in.slice(0, 5) : "", time_out: e.time_out ? e.time_out.slice(0, 5) : "", remarks: e.remarks || "" },
      locked: e.validation_status === "locked",
    })),
  };
}

/** Saves the encoding sheet. Rows with no status are skipped; locked records are never touched.
 *  Row keys are "e<employeeId>": purely numeric keys would be compacted into an array by the query-string parser. */
export async function saveSheet(req, date, rows) {
  if (date > iso(new Date())) throw badRequest("Attendance cannot be encoded for a future date.");
  const cfg = await schedule();
  const errors = {};
  const prepared = [];
  for (const [key, v] of Object.entries(rows || {})) {
    const empId = /^e(\d+)$/.exec(key)?.[1];
    if (!empId || !v || typeof v !== "object" || !v.status) continue;
    if (!STATUSES.includes(v.status)) { errors[empId] = "Invalid status."; continue; }
    try { prepared.push({ empId: Number(empId), ...computeDay({ status: v.status, time_in: v.time_in || null, time_out: v.time_out || null }, cfg), remarks: String(v.remarks || "").slice(0, 255) || null }); }
    catch (e) { errors[empId] = e.message; }
  }
  if (Object.keys(errors).length) return { saved: 0, errors };
  let saved = 0, skipped = 0;
  await tx(async (trx) => {
    for (const p of prepared) {
      const cur = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ? FOR UPDATE", [p.empId, date], trx);
      if (cur?.validation_status === "locked") { skipped++; continue; }
      const same = cur && cur.status === p.status && (cur.time_in || null)?.slice(0, 5) === (p.time_in || null)?.slice(0, 5)
        && (cur.time_out || null)?.slice(0, 5) === (p.time_out || null)?.slice(0, 5) && (cur.remarks || null) === p.remarks;
      if (same) continue;
      if (cur) {
        // any edit sends the record back for validation
        await exec(
          `UPDATE attendance_records SET status = ?, time_in = ?, time_out = ?, late_minutes = ?, undertime_minutes = ?, hours_worked = ?,
                  remarks = ?, source = 'manual', validation_status = 'pending', validated_by = NULL, validated_at = NULL WHERE id = ?`,
          [p.status, p.time_in, p.time_out, p.late_minutes, p.undertime_minutes, p.hours_worked, p.remarks, cur.id], trx);
      } else {
        await exec(
          `INSERT INTO attendance_records (employee_id, work_date, status, time_in, time_out, late_minutes, undertime_minutes, hours_worked, remarks, source, created_by)
           VALUES (?,?,?,?,?,?,?,?,?, 'manual', ?)`,
          [p.empId, date, p.status, p.time_in, p.time_out, p.late_minutes, p.undertime_minutes, p.hours_worked, p.remarks, req.user.id], trx);
      }
      await audit(req, {
        action: cur ? "attendance_updated" : "attendance_encoded", module: "attendance", recordType: "attendance", recordId: `${p.empId}:${date}`,
        previous: cur ? { status: cur.status, time_in: cur.time_in, time_out: cur.time_out, validation: cur.validation_status } : null,
        next: { status: p.status, time_in: p.time_in, time_out: p.time_out, late: p.late_minutes, undertime: p.undertime_minutes },
      }, trx);
      saved++;
    }
  });
  return { saved, skipped, errors: {} };
}

// ---- validation ----------------------------------------------------------------------------------------------------------
export async function pendingForValidation(req) {
  const { from, to } = dateRange(req, 31);
  const department = /^\d+$/.test(req.query.department || "") ? Number(req.query.department) : null;
  const rows = await select(
    `SELECT a.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department, c.full_name AS encoded_by
       FROM attendance_records a JOIN employees e ON e.id = a.employee_id JOIN departments d ON d.id = e.department_id
       LEFT JOIN users c ON c.id = a.created_by
      WHERE a.validation_status = 'pending' AND a.work_date BETWEEN ? AND ? ${department ? "AND e.department_id = ?" : ""}
      ORDER BY a.work_date, e.last_name LIMIT 500`, department ? [from, to, department] : [from, to]);
  return { rows: rows.map((r) => ({ ...r, name: fullName(r), own: r.employee_id === req.user.employee_id })), from, to, department };
}

/** Marks pending records as validated. A user never validates their own attendance. */
export async function validateRecords(req, ids) {
  const clean = [...new Set((ids || []).filter((x) => /^\d+$/.test(String(x))).map(Number))].slice(0, 500);
  if (!clean.length) throw badRequest("Select at least one record to validate.");
  return tx(async (trx) => {
    const rows = await select(`SELECT id, employee_id, work_date FROM attendance_records WHERE id IN (?) AND validation_status = 'pending' FOR UPDATE`, [clean], trx);
    const mine = rows.filter((r) => r.employee_id === req.user.employee_id);
    const ok = rows.filter((r) => r.employee_id !== req.user.employee_id);
    if (ok.length) {
      await exec(`UPDATE attendance_records SET validation_status = 'validated', validated_by = ?, validated_at = NOW() WHERE id IN (?)`, [req.user.id, ok.map((r) => r.id)], trx);
      await audit(req, { action: "attendance_validated", module: "attendance", recordType: "attendance", recordId: ok.length === 1 ? ok[0].id : null, remarks: `${ok.length} record(s) validated`, next: { ids: ok.map((r) => r.id) } }, trx);
    }
    return { validated: ok.length, skippedOwn: mine.length };
  });
}

// ---- correction review (Accounting Supervisor) ------------------------------------------------------------------------------------
export async function correctionQueue(req) {
  const t = tableState(req, { sortable: { submitted: "r.submitted_at", date: "r.work_date", employee: "e.last_name" }, defaultSort: "submitted", defaultDir: "asc" });
  const status = ["pending", "approved", "rejected", "cancelled"].includes(req.query.status) ? req.query.status : req.query.status === "all" ? null : "pending";
  const where = []; const params = [];
  if (status) { where.push("r.status = ?"); params.push(status); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ? OR r.request_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM attendance_correction_requests r JOIN employees e ON e.id = r.employee_id ${W}`, params));
  const rows = await select(
    `SELECT r.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department
       FROM attendance_correction_requests r JOIN employees e ON e.id = r.employee_id JOIN departments d ON d.id = e.department_id
       ${W} ORDER BY ${t.orderBy}, r.id LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows: rows.map((r) => ({ ...r, name: fullName(r) })), t, status: status || "all", meta: tableMeta(req, t, total, { status: status || "all" }) };
}

export async function getCorrection(id) {
  const r = await selectOne(
    `SELECT r.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department, p.title AS position,
            s.full_name AS submitted_by_name, x.full_name AS decided_by_name, doc.original_name AS attachment_name,
            a.validation_status AS record_validation
       FROM attendance_correction_requests r JOIN employees e ON e.id = r.employee_id JOIN departments d ON d.id = e.department_id
       JOIN positions p ON p.id = e.position_id JOIN users s ON s.id = r.submitted_by LEFT JOIN users x ON x.id = r.decided_by
       LEFT JOIN document_attachments doc ON doc.id = r.attachment_id LEFT JOIN attendance_records a ON a.employee_id = r.employee_id AND a.work_date = r.work_date
      WHERE r.id = ?`, [id]);
  if (!r) throw notFound("Correction request not found.");
  r.name = fullName(r);
  r.approvals = await select("SELECT a.*, u.full_name FROM attendance_correction_approvals a JOIN users u ON u.id = a.actor_id WHERE a.request_id = ? ORDER BY a.id", [id]);
  return r;
}

export async function decideCorrection(req, id, action, remarks, opts = {}) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting a request.");
  const cfg = await schedule();
  return tx(async (trx) => {
    const r = await selectOne("SELECT * FROM attendance_correction_requests WHERE id = ? FOR UPDATE", [id], trx);
    if (!r) throw notFound("Correction request not found.");
    if (r.status !== "pending") throw badRequest(`This request was already ${r.status}.`);
    guardRouting(r, req, opts);
    if (r.submitted_by === req.user.id || (req.user.employee_id && r.employee_id === req.user.employee_id)) throw forbidden("You cannot decide on your own attendance correction.");
    const cur = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ? FOR UPDATE", [r.employee_id, r.work_date], trx);
    if (action === "approved") {
      if (cur?.validation_status === "locked") throw badRequest("This day is already in finalized payroll and can only be corrected through a payroll adjustment.");
      const c = computeDay({ status: r.requested_status, time_in: r.requested_time_in, time_out: r.requested_time_out }, cfg);
      if (cur) {
        await exec(
          `UPDATE attendance_records SET status = ?, time_in = ?, time_out = ?, late_minutes = ?, undertime_minutes = ?, hours_worked = ?, source = 'correction',
                  validation_status = 'validated', validated_by = ?, validated_at = NOW(), remarks = ? WHERE id = ?`,
          [c.status, c.time_in, c.time_out, c.late_minutes, c.undertime_minutes, c.hours_worked, req.user.id, `Corrected via ${r.request_no}`, cur.id], trx);
      } else {
        await exec(
          `INSERT INTO attendance_records (employee_id, work_date, status, time_in, time_out, late_minutes, undertime_minutes, hours_worked, source,
             validation_status, validated_by, validated_at, remarks, created_by) VALUES (?,?,?,?,?,?,?,?, 'correction', 'validated', ?, NOW(), ?, ?)`,
          [r.employee_id, r.work_date, c.status, c.time_in, c.time_out, c.late_minutes, c.undertime_minutes, c.hours_worked, req.user.id, `Corrected via ${r.request_no}`, req.user.id], trx);
      }
    }
    await exec("UPDATE attendance_correction_requests SET status = ?, decided_by = ?, approver_name = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [action, req.user.id ?? null, req.user.full_name ?? null, remarks || null, id], trx);
    await exec("INSERT INTO attendance_correction_approvals (request_id, action, actor_id, actor_role, actor_name, remarks) VALUES (?,?,?,?,?,?)", [id, action, req.user.id ?? null, req.user.role_code, req.user.full_name ?? null, remarks || null], trx);
    await reportOutcome("attendance_correction", r, action, req, trx);
    await audit(req, {
      action: `attendance_correction_${action}`, module: "attendance", recordType: "attendance_correction_request", recordId: id, decision: action, remarks,
      previous: cur ? { status: cur.status, time_in: cur.time_in, time_out: cur.time_out } : { record: "none" },
      next: action === "approved" ? { status: r.requested_status, time_in: r.requested_time_in, time_out: r.requested_time_out } : null,
    }, trx);
    await notifyEmployee(r.employee_id, {
      type: `attendance_correction_${action}`,
      title: action === "approved" ? "Attendance correction approved" : "Attendance correction rejected",
      message: action === "approved" ? `Your attendance for ${r.work_date} was corrected (${r.request_no}).` : `Your request ${r.request_no} for ${r.work_date} was rejected: ${remarks}`,
      relatedType: "attendance_correction_request", relatedId: id, link: `/my/attendance?month=${String(r.work_date).slice(0, 7)}`,
    }, trx);
    return r;
  });
}
