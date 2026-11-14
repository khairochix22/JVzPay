// Leave (Module 5) — supervisor review, leave-type configuration, balance adjustments and the leave calendar.
// Approving converts the reservation into used days and marks the attendance days as on_leave (never touching days already
// locked by finalized payroll); rejecting releases the reserved days. Rejected applications keep their details and reason.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyEmployee } from "../lib/notify.js";
import { getSetting } from "../lib/settings.js";
import { routeFor, sendToDepartment, guardRouting, reportOutcome } from "./requestRouting.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { fullName } from "./employeeService.js";
import { ensureBalances, remainingOf } from "./leaveService.js";
import { daysOffBetween, defaultRestDays } from "./scheduleService.js";
import { LeaveType } from "../models/index.js";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };

// ---- review queue ------------------------------------------------------------------------------------------------------------
export async function leaveQueue(req) {
  const t = tableState(req, { sortable: { submitted: "a.submitted_at", start: "a.start_date", employee: "e.last_name" }, defaultSort: "submitted", defaultDir: "asc" });
  const status = ["pending", "approved", "rejected", "cancelled"].includes(req.query.status) ? req.query.status : req.query.status === "all" ? null : "pending";
  const where = []; const params = [];
  if (status) { where.push("a.status = ?"); params.push(status); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ? OR a.application_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM leave_applications a JOIN employees e ON e.id = a.employee_id ${W}`, params));
  const rows = await select(
    `SELECT a.*, t.name AS type_name, t.is_paid, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department
       FROM leave_applications a JOIN leave_types t ON t.id = a.leave_type_id JOIN employees e ON e.id = a.employee_id JOIN departments d ON d.id = e.department_id
       ${W} ORDER BY ${t.orderBy}, a.id LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows: rows.map((r) => ({ ...r, name: fullName(r) })), t, status: status || "all", meta: tableMeta(req, t, total, { status: status || "all" }) };
}

export async function getApplication(id) {
  const a = await selectOne(
    `SELECT a.*, t.name AS type_name, t.code AS type_code, t.is_paid, t.allow_negative_balance, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix,
            d.name AS department, p.title AS position, s.full_name AS submitted_by_name, x.full_name AS decided_by_name, doc.original_name AS attachment_name
       FROM leave_applications a JOIN leave_types t ON t.id = a.leave_type_id JOIN employees e ON e.id = a.employee_id
       JOIN departments d ON d.id = e.department_id JOIN positions p ON p.id = e.position_id JOIN users s ON s.id = a.submitted_by
       LEFT JOIN users x ON x.id = a.decided_by LEFT JOIN document_attachments doc ON doc.id = a.attachment_id
      WHERE a.id = ?`, [id]);
  if (!a) throw notFound("Leave application not found.");
  a.name = fullName(a);
  const year = Number(String(a.start_date).slice(0, 4));
  a.balance = await selectOne("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?", [a.employee_id, a.leave_type_id, year]);
  if (a.balance) a.balance.remaining = remainingOf(a.balance);
  a.overlapping = await select(
    `SELECT a2.application_no, a2.start_date, a2.end_date, e2.first_name, e2.last_name FROM leave_applications a2 JOIN employees e2 ON e2.id = a2.employee_id
      WHERE a2.status = 'approved' AND a2.id <> ? AND a2.start_date <= ? AND a2.end_date >= ? AND e2.department_id = (SELECT department_id FROM employees WHERE id = ?)`,
    [id, a.end_date, a.start_date, a.employee_id]);
  a.approvals = await select("SELECT l.*, u.full_name FROM leave_approvals l JOIN users u ON u.id = l.actor_id WHERE l.application_id = ? ORDER BY l.id", [id]);
  return a;
}

export async function decideLeave(req, id, action, remarks, opts = {}) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting a leave application.");
  return tx(async (trx) => {
    const a = await selectOne("SELECT * FROM leave_applications WHERE id = ? FOR UPDATE", [id], trx);
    if (!a) throw notFound("Leave application not found.");
    if (a.status !== "pending") throw badRequest(`This application was already ${a.status}.`);
    guardRouting(a, req, opts);
    if (a.submitted_by === req.user.id || (req.user.employee_id && a.employee_id === req.user.employee_id)) throw forbidden("You cannot decide on your own leave application.");
    const year = Number(String(a.start_date).slice(0, 4));
    const bal = await selectOne("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ? FOR UPDATE", [a.employee_id, a.leave_type_id, year], trx);
    const days = Number(a.days);
    let marked = 0;
    if (action === "approved") {
      await exec("UPDATE leave_balances SET pending_days = GREATEST(pending_days - ?, 0), used_days = used_days + ? WHERE id = ?", [days, days, bal.id], trx);
      if (days >= 1) {
        const off = await daysOffBetween(a.employee_id, String(a.start_date).slice(0, 10), String(a.end_date).slice(0, 10), trx);
        const holidays = new Set((await select("SELECT holiday_date FROM holidays WHERE is_active = 1 AND holiday_type IN ('regular','special_non_working') AND holiday_date BETWEEN ? AND ?", [a.start_date, a.end_date], trx)).map((h) => h.holiday_date));
        for (let d = parse(a.start_date); d <= parse(a.end_date); d.setDate(d.getDate() + 1)) {
          const day = iso(d);
          if (off.has(day) || holidays.has(day)) continue;
          const cur = await selectOne("SELECT id, validation_status FROM attendance_records WHERE employee_id = ? AND work_date = ? FOR UPDATE", [a.employee_id, day], trx);
          if (cur?.validation_status === "locked") throw badRequest(`${day} is already included in finalized payroll. Correct it through a payroll adjustment instead.`);
          if (cur) {
            await exec(`UPDATE attendance_records SET status = 'on_leave', time_in = NULL, time_out = NULL, late_minutes = 0, undertime_minutes = 0, hours_worked = 0,
                          source = 'leave', validation_status = 'validated', validated_by = ?, validated_at = NOW(), remarks = ? WHERE id = ?`, [req.user.id, a.application_no, cur.id], trx);
          } else {
            await exec(`INSERT INTO attendance_records (employee_id, work_date, status, source, validation_status, validated_by, validated_at, remarks, created_by)
                        VALUES (?,?,'on_leave','leave','validated',?,NOW(),?,?)`, [a.employee_id, day, req.user.id, a.application_no, req.user.id], trx);
          }
          marked++;
        }
      }
    } else {
      await exec("UPDATE leave_balances SET pending_days = GREATEST(pending_days - ?, 0) WHERE id = ?", [days, bal.id], trx);
    }
    await exec("UPDATE leave_applications SET status = ?, decided_by = ?, approver_name = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [action, req.user.id ?? null, req.user.full_name ?? null, remarks || null, id], trx);
    await exec("INSERT INTO leave_approvals (application_id, action, actor_id, actor_role, actor_name, remarks) VALUES (?,?,?,?,?,?)", [id, action, req.user.id ?? null, req.user.role_code, req.user.full_name ?? null, remarks || null], trx);
    await reportOutcome("leave", a, action, req, trx);
    await audit(req, { action: `leave_${action}`, module: "leave", recordType: "leave_application", recordId: id, decision: action, remarks, next: { application_no: a.application_no, days, attendance_days_marked: marked } }, trx);
    await notifyEmployee(a.employee_id, {
      type: `leave_${action}`, title: action === "approved" ? "Leave approved" : "Leave rejected",
      message: action === "approved" ? `${a.application_no} (${days} day${days === 1 ? "" : "s"}) was approved.` : `${a.application_no} was rejected: ${remarks}`,
      relatedType: "leave_application", relatedId: id, link: "/my/leave",
    }, trx);
    return a;
  });
}

// ---- leave types (leave.config) — uses the LeaveType model -------------------------------------------------------------------------
export const leaveTypeSchema = {
  code: { label: "Code", required: true, max: 20, pattern: /^[A-Za-z0-9_-]+$/, patternMessage: "Use letters, digits, dash or underscore." },
  name: { label: "Name", required: true, max: 80 },
  annual_entitlement_days: { label: "Annual entitlement (days)", type: "money", required: true, min: 0, max: 365 },
  is_paid: { type: "bool" },
  requires_attachment: { type: "bool" },
  attachment_after_days: { label: "Attachment required beyond (days)", type: "money", min: 0, max: 365 },
  allow_negative_balance: { type: "bool" },
  is_active: { type: "bool" },
};

export const listLeaveTypes = () => LeaveType.findAll({ order: [["is_active", "DESC"], ["name", "ASC"]], raw: true });

export async function saveLeaveType(req, id, values) {
  const data = { ...values, code: values.code.toUpperCase(), attachment_after_days: values.requires_attachment ? values.attachment_after_days : null };
  const dupe = await LeaveType.findOne({ where: { code: data.code }, raw: true });
  if (dupe && dupe.id !== id) throw badRequest("Another leave type already uses this code.");
  if (id) {
    const cur = await LeaveType.findByPk(id);
    if (!cur) throw notFound("Leave type not found.");
    const prev = cur.get({ plain: true });
    await cur.update(data);
    await audit(req, { action: "leave_type_updated", module: "leave", recordType: "leave_type", recordId: id, previous: prev, next: data });
    return id;
  }
  const created = await LeaveType.create(data);
  await audit(req, { action: "leave_type_created", module: "leave", recordType: "leave_type", recordId: created.id, next: data });
  return created.id;
}

// ---- balances & adjustments ----------------------------------------------------------------------------------------------------
export async function balancesPage(req) {
  const year = /^\d{4}$/.test(req.query.year || "") ? Number(req.query.year) : new Date().getFullYear();
  const t = tableState(req, { sortable: { employee: "e.last_name", dept: "d.name" }, defaultSort: "employee", perPage: 20 });
  const department = /^\d+$/.test(req.query.department || "") ? Number(req.query.department) : null;
  const where = ["e.deleted_at IS NULL", "e.employment_status IN ('active','on_leave')"]; const params = [];
  if (department) { where.push("e.department_id = ?"); params.push(department); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.join(" AND ");
  const total = Number(await scalar(`SELECT COUNT(*) FROM employees e JOIN departments d ON d.id = e.department_id WHERE ${W}`, params));
  const emps = await select(`SELECT e.id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department
       FROM employees e JOIN departments d ON d.id = e.department_id WHERE ${W} ORDER BY ${t.orderBy}, e.id LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  for (const e of emps) await ensureBalances(e.id, year);
  const types = await select("SELECT id, code, name, allow_negative_balance FROM leave_types WHERE is_active = 1 ORDER BY name");
  const bals = emps.length ? await select("SELECT * FROM leave_balances WHERE year = ? AND employee_id IN (?)", [year, emps.map((e) => e.id)]) : [];
  const rows = emps.map((e) => ({
    ...e, name: fullName(e),
    cells: types.map((ty) => { const b = bals.find((x) => x.employee_id === e.id && x.leave_type_id === ty.id); return b ? { ...b, remaining: remainingOf(b), total: Number(b.entitled_days) + Number(b.adjusted_days) } : null; }),
  }));
  return { year, types, rows, t, department, meta: tableMeta(req, t, total, { year, department: department || undefined }) };
}

export async function adjustBalance(req, values) {
  const delta = Number(values.delta);
  if (!delta) throw badRequest("Enter a non-zero adjustment.");
  if (Math.abs(delta) > 365 || Math.round(delta * 2) !== delta * 2) throw badRequest("Adjustments must be in half-day steps and at most 365 days.");
  return tx(async (trx) => {
    await ensureBalances(values.employee_id, values.year, trx);
    const b = await selectOne(
      `SELECT b.*, t.name AS type_name, t.allow_negative_balance FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
        WHERE b.employee_id = ? AND b.leave_type_id = ? AND b.year = ? FOR UPDATE`, [values.employee_id, values.leave_type_id, values.year], trx);
    if (!b) throw notFound("Leave balance not found.");
    const after = remainingOf({ ...b, adjusted_days: Number(b.adjusted_days) + delta });
    if (after < 0 && !b.allow_negative_balance) throw badRequest(`This adjustment would make the ${b.type_name} balance negative (${after} days).`);
    await exec("UPDATE leave_balances SET adjusted_days = adjusted_days + ? WHERE id = ?", [delta, b.id], trx);
    await audit(req, { action: "leave_balance_adjusted", module: "leave", recordType: "leave_balance", recordId: b.id, remarks: values.reason,
      previous: { adjusted_days: b.adjusted_days, remaining: remainingOf(b) }, next: { delta, remaining: after } }, trx);
    await notifyEmployee(values.employee_id, { type: "leave_balance_adjusted", title: "Leave credits adjusted", message: `${b.type_name} ${values.year}: ${delta > 0 ? "+" : ""}${delta} day(s). Reason: ${values.reason}`, link: "/my/leave" }, trx);
  });
}

// ---- calendar ---------------------------------------------------------------------------------------------------------------
export async function calendar(req) {
  const m = /^(\d{4})-(\d{2})$/.exec(req.query.month || "");
  const now = new Date();
  const y = m ? Number(m[1]) : now.getFullYear(), mo = m ? Number(m[2]) : now.getMonth() + 1;
  const first = new Date(y, mo - 1, 1), last = new Date(y, mo, 0);
  const department = /^\d+$/.test(req.query.department || "") ? Number(req.query.department) : null;
  const apps = await select(
    `SELECT a.id, a.application_no, a.start_date, a.end_date, a.status, a.days, t.code, t.name AS type_name, e.first_name, e.last_name
       FROM leave_applications a JOIN leave_types t ON t.id = a.leave_type_id JOIN employees e ON e.id = a.employee_id
      WHERE a.status IN ('approved','pending') AND a.start_date <= ? AND a.end_date >= ? ${department ? "AND e.department_id = ?" : ""}
      ORDER BY a.start_date`, department ? [iso(last), iso(first), department] : [iso(last), iso(first)]);
  const holidays = await select("SELECT holiday_date, name FROM holidays WHERE is_active = 1 AND holiday_date BETWEEN ? AND ?", [iso(first), iso(last)]);
  const restDays = await defaultRestDays();
  const weeks = [];
  let week = new Array(first.getDay()).fill(null);
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const day = iso(d);
    week.push({
      day: d.getDate(), date: day, today: day === iso(now), rest: restDays.includes(d.getDay()),
      holiday: holidays.find((h) => h.holiday_date === day)?.name || null,
      items: apps.filter((a) => a.start_date <= day && a.end_date >= day).map((a) => ({ ...a, who: `${a.first_name} ${a.last_name.charAt(0)}.` })),
    });
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length) weeks.push([...week, ...new Array(7 - week.length).fill(null)]);
  const prev = new Date(y, mo - 2, 1), next = new Date(y, mo, 1);
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { weeks, label: first.toLocaleDateString("en-PH", { month: "long", year: "numeric" }), prev: ym(prev), next: ym(next), month: ym(first), department, apps };
}
