// Overtime (Module 4): Payroll Staff encode → Accounting Supervisor approves/rejects → approved hours are paid by the payroll
// engine (and linked to the payroll record when the batch is finalized, so they can never be paid twice).
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyEmployee, notifyPermission } from "../lib/notify.js";
import { validate } from "../lib/validate.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { fullName } from "./employeeService.js";
import { dateRange, schedule } from "./attendanceService.js";
import { nextDocNo } from "../lib/sequence.js";
import { routeFor, guardRouting, reportOutcome } from "./requestRouting.js";
import { startApproval } from "./supervisorApproval.js";
import { scheduleFor, defaultFor, isDayOff } from "./scheduleService.js";

export const OT_TYPES = ["regular", "rest_day", "holiday"];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function listOvertime(req, { defaultStatus = null } = {}) {
  const t = tableState(req, { sortable: { date: "o.work_date", employee: "e.last_name", submitted: "o.submitted_at" }, defaultSort: "date", defaultDir: "desc" });
  const { from, to } = dateRange(req, 31);
  const status = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : req.query.status === "all" ? null : defaultStatus;
  const where = ["o.work_date BETWEEN ? AND ?"]; const params = [from, to];
  if (status) { where.push("o.status = ?"); params.push(status); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.join(" AND ");
  const total = Number(await scalar(`SELECT COUNT(*) FROM overtime_records o JOIN employees e ON e.id = o.employee_id WHERE ${W}`, params));
  const rows = await select(
    `SELECT o.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department,
            s.full_name AS submitted_by_name, x.full_name AS decided_by_name
       FROM overtime_records o JOIN employees e ON e.id = o.employee_id JOIN departments d ON d.id = e.department_id
       JOIN users s ON s.id = o.submitted_by LEFT JOIN users x ON x.id = o.decided_by
      WHERE ${W} ORDER BY ${t.orderBy}, o.id DESC LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  const totals = await selectOne(`SELECT COALESCE(SUM(o.hours),0) AS hours, COALESCE(SUM(o.status='pending'),0) AS pending FROM overtime_records o JOIN employees e ON e.id = o.employee_id WHERE ${W}`, params);
  return {
    rows: rows.map((r) => ({ ...r, name: fullName(r), own: r.employee_id === req.user.employee_id || r.submitted_by === req.user.id })),
    t, from, to, status: status || "all", totals,
    meta: tableMeta(req, t, total, { from, to, status: status || "all" }),
  };
}

export function validateOvertime(body) {
  const { values, errors } = validate(body, {
    employee_id: { label: "Employee", type: "id", required: true },
    work_date: { label: "Date", type: "date", required: true },
    hours: { label: "Hours", type: "money", required: true, min: 0.5, max: 12 },
    ot_type: { label: "Overtime type", type: "enum", values: OT_TYPES, required: true },
    reason: { label: "Reason", required: true, min: 5, max: 255 },
  });
  if (!errors.work_date) {
    const earliest = new Date(); earliest.setDate(earliest.getDate() - 60);
    if (values.work_date > iso(new Date())) errors.work_date = "Overtime can only be encoded after it was worked.";
    else if (values.work_date < iso(earliest)) errors.work_date = "Overtime older than 60 days cannot be encoded.";
  }
  if (!errors.hours && !/^\d+(\.(0|00|5|50|25|75))?$/.test(String(values.hours))) errors.hours = "Use quarter-hour steps (e.g. 1.5 or 2.25).";
  return { values, errors };
}

export async function submitOvertime(req, values) {
  return tx(async (trx) => {
    const emp = await selectOne("SELECT id, first_name, middle_name, last_name, suffix, employment_status, date_hired FROM employees WHERE id = ? AND deleted_at IS NULL FOR UPDATE", [values.employee_id], trx);
    if (!emp) throw badRequest("Employee not found.");
    if (emp.id === req.user.employee_id) throw forbidden("You cannot encode overtime for yourself. Ask another Payroll Staff member.");
    if (values.work_date < emp.date_hired) throw badRequest("The employee was not yet hired on that date.");
    const dup = await scalar("SELECT COUNT(*) FROM overtime_records WHERE employee_id = ? AND work_date = ? AND status IN ('pending','approved')", [emp.id, values.work_date], trx);
    if (Number(dup)) throw badRequest("Overtime for this employee and date is already pending or approved.");
    const { insertId } = await exec(
      "INSERT INTO overtime_records (employee_id, work_date, hours, ot_type, reason, submitted_by) VALUES (?,?,?,?,?,?)",
      [emp.id, values.work_date, values.hours, values.ot_type, values.reason, req.user.id], trx);
    await audit(req, { action: "overtime_submitted", module: "overtime", recordType: "overtime", recordId: insertId, next: { employee_id: emp.id, date: values.work_date, hours: values.hours, type: values.ot_type } }, trx);
    await notifyPermission("overtime.approve", {
      type: "overtime_submitted", title: "Overtime awaiting approval",
      message: `${values.hours} h of ${values.ot_type.replace("_", " ")} overtime for ${fullName(emp)} on ${values.work_date}.`,
      relatedType: "overtime", relatedId: insertId, link: "/overtime/review",
    }, { excludeUserId: req.user.id }, trx);
    return insertId;
  });
}

export async function suggestType(date, employeeId = null) {
  const sched = employeeId ? await scheduleFor(employeeId, date) : await defaultFor(date);
  const h = await selectOne("SELECT holiday_type FROM holidays WHERE holiday_date = ? AND is_active = 1", [date]);
  if (h?.holiday_type === "regular") return "holiday";
  if (h?.holiday_type === "special_non_working" || isDayOff(sched, date)) return "rest_day";
  return "regular";
}

export async function decideOvertime(req, id, action, remarks, opts = {}) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting overtime.");
  return tx(async (trx) => {
    const o = await selectOne("SELECT * FROM overtime_records WHERE id = ? FOR UPDATE", [id], trx);
    if (!o) throw notFound("Overtime record not found.");
    if (o.status !== "pending") throw badRequest(`This overtime was already ${o.status}.`);
    guardRouting(o, req, opts);
    if (o.submitted_by === req.user.id || (req.user.employee_id && o.employee_id === req.user.employee_id)) throw forbidden("You cannot approve overtime you encoded or your own overtime.");
    await exec("UPDATE overtime_records SET status = ?, decided_by = ?, approver_name = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [action, req.user.id ?? null, req.user.full_name ?? null, remarks || null, id], trx);
    if (o.source === "employee") await reportOutcome("overtime", o, action, req, trx);
    await audit(req, { action: `overtime_${action}`, module: "overtime", recordType: "overtime", recordId: id, decision: action, remarks, next: { hours: o.hours, date: o.work_date } }, trx);
    await notifyEmployee(o.employee_id, {
      type: `overtime_${action}`, title: action === "approved" ? "Overtime approved" : "Overtime rejected",
      message: action === "approved" ? `${o.hours} h of overtime on ${o.work_date} will be included in your payroll.` : `Overtime on ${o.work_date} was rejected: ${remarks}`,
      relatedType: "overtime", relatedId: id, link: `/my/attendance?month=${String(o.work_date).slice(0, 7)}`,
    }, trx);
    return o;
  });
}

export const activeEmployees = () =>
  select(`SELECT e.id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix FROM employees e
           WHERE e.deleted_at IS NULL AND e.employment_status IN ('active','on_leave') ORDER BY e.last_name, e.first_name`)
    .then((r) => r.map((e) => ({ ...e, name: fullName(e) })));

// ---- Self-Service overtime applications (master prompt §V) ----------------------------------------------------------------
// The employee applies with the date, start and end time and reason; routed like leave (requestRouting.js).
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };

export function checkApplication(body) {
  const v = { work_date: String(body.work_date || ""), start_time: String(body.start_time || "").slice(0, 5), end_time: String(body.end_time || "").slice(0, 5), reason: String(body.reason || "").trim().slice(0, 255) };
  const errors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.work_date)) errors.work_date = "Enter the date of the overtime.";
  else {
    const diff = (new Date(`${v.work_date}T00:00:00`) - new Date(new Date().toDateString())) / 864e5;
    if (diff < -31 || diff > 31) errors.work_date = "Apply within 31 days before or after the overtime.";
  }
  if (!/^\d{2}:\d{2}$/.test(v.start_time)) errors.start_time = "Enter the start time.";
  if (!/^\d{2}:\d{2}$/.test(v.end_time)) errors.end_time = "Enter the end time.";
  if (!errors.start_time && !errors.end_time) {
    const mins = toMin(v.end_time) - toMin(v.start_time);
    if (mins <= 0) errors.end_time = "The end time must be after the start time (same day).";
    else if (mins > 12 * 60) errors.end_time = "Overtime longer than 12 hours in a day is not accepted.";
    else v.hours = Math.round((mins / 60) * 100) / 100;
  }
  if (!v.reason) errors.reason = "State the reason.";
  return { values: v, errors };
}

export async function applyOvertime(req, v) {
  const employeeId = req.user.employee_id;
  const type = await suggestType(v.work_date, employeeId);
  return tx(async (trx) => {
    await selectOne("SELECT id FROM employees WHERE id = ? FOR UPDATE", [employeeId], trx);
    if (Number(await scalar("SELECT COUNT(*) FROM overtime_records WHERE employee_id = ? AND work_date = ? AND status IN ('pending','approved')", [employeeId, v.work_date], trx)))
      throw badRequest("There is already overtime pending or approved for this date.");
    const no = await nextDocNo("OT", 4, trx);
    const { emp, routed, approver } = await routeFor(employeeId, trx);
    const { insertId } = await exec(
      `INSERT INTO overtime_records (request_no, employee_id, work_date, start_time, end_time, hours, ot_type, reason, source, routed_to, submitted_by)
       VALUES (?,?,?,?,?,?,?,?, 'employee', ?, ?)`,
      [no, employeeId, v.work_date, v.start_time, v.end_time, v.hours, type, v.reason, routed, req.user.id], trx);
    await startApproval("overtime", insertId, approver, req, trx);
    await audit(req, { action: "overtime_applied", module: "overtime", recordType: "overtime", recordId: insertId, next: { request_no: no, date: v.work_date, hours: v.hours, routed } }, trx);
    return { id: insertId, no, hours: v.hours, routed };
  });
}

export async function cancelApplication(req, id) {
  const o = await selectOne("SELECT * FROM overtime_records WHERE id = ?", [id]);
  if (!o || o.employee_id !== req.user.employee_id || o.source !== "employee") throw notFound("Overtime application not found.");
  if (o.status !== "pending") throw badRequest("Only pending applications can be cancelled.");
  await exec("UPDATE overtime_records SET status = 'rejected', decision_remarks = 'Cancelled by the employee', decided_at = NOW() WHERE id = ?", [id]);
  await audit(req, { action: "overtime_cancelled", module: "overtime", recordType: "overtime", recordId: id });
}

export async function myOvertime(employeeId) {
  const [rows, month, pending, route] = await Promise.all([
    select("SELECT * FROM overtime_records WHERE employee_id = ? ORDER BY work_date DESC, id DESC LIMIT 60", [employeeId]),
    scalar("SELECT COALESCE(SUM(hours), 0) FROM overtime_records WHERE employee_id = ? AND status = 'approved' AND work_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')", [employeeId]),
    scalar("SELECT COUNT(*) FROM overtime_records WHERE employee_id = ? AND status = 'pending'", [employeeId]),
    routeFor(employeeId),
  ]);
  const a = route.approver;
  return { rows, approvedMonth: Number(month), pending: Number(pending), firstApprover: a.mode === "user" ? a.name : a.mode === "role" ? "the Accounting Supervisor" : null };
}
