// Schedules are plotted by HR, day by day, and can change at any time — days off included (owner, 2026-11-13).
// HR sends each plotted day through the integration (ScheduleDaysPlotted, see scheduleHandlers.js); JVzPay keeps one row
// per employee and date in schedule_days. A day HR has not plotted follows the company default from System Settings
// (Monday to Friday, 08:00–17:00, breaks 10:00 and 15:00, lunch 12:00–13:00, Saturday and Sunday off).
// Breaks are 15 minutes and paid; lunch is unpaid. My Schedule shows a month calendar: holidays, leave and overtime on
// each day, and the full plotted day when the employee clicks it. Approved overtime appears as soon as it is decided.
import { select, selectOne } from "../lib/db.js";
import { getSetting } from "../lib/settings.js";
import { fullName } from "./employeeService.js";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

async function defaults() {
  const lunchStart = hhmm(await getSetting("attendance.lunch_start", "12:00"));
  const lunchMin = Number(await getSetting("attendance.break_minutes", 60));
  const r1 = Number(await getSetting("attendance.rest_day", 0));
  const r2raw = await getSetting("attendance.rest_day_2", null);
  const r2 = r2raw === null || r2raw === "" || Number(r2raw) === r1 ? null : Number(r2raw);
  return {
    restDays: r2 === null ? [r1] : [r1, r2],
    breakMinutes: Number(await getSetting("attendance.short_break_minutes", 15)),
    shift_start: hhmm(await getSetting("attendance.work_start", "08:00")),
    am_break_start: hhmm(await getSetting("attendance.am_break_start", "10:00")),
    lunch_start: lunchStart,
    lunch_end: fromMin(toMin(lunchStart) + lunchMin),
    pm_break_start: hhmm(await getSetting("attendance.pm_break_start", "15:00")),
    shift_end: hhmm(await getSetting("attendance.work_end", "17:00")),
  };
}

/** Adds the break ends and readable labels to a day's schedule. */
function finish(day, breakMinutes) {
  if (day.dayOff) return day;
  return {
    ...day,
    am_break_end: fromMin(toMin(day.am_break_start) + breakMinutes),
    pm_break_end: fromMin(toMin(day.pm_break_start) + breakMinutes),
    breakMinutes,
    lunchMinutes: toMin(day.lunch_end) - toMin(day.lunch_start),
  };
}

const fromRow = (r, breakMinutes) => finish({
  source: "hr", date: String(r.work_date).slice(0, 10), dayOff: !!r.is_day_off, remarks: r.remarks,
  shift_start: hhmm(r.shift_start), am_break_start: hhmm(r.am_break_start), lunch_start: hhmm(r.lunch_start),
  lunch_end: hhmm(r.lunch_end), pm_break_start: hhmm(r.pm_break_start), shift_end: hhmm(r.shift_end),
}, breakMinutes);

const fromDefault = (date, def) => {
  const dayOff = def.restDays.includes(parse(date).getDay());
  return finish({
    source: "default", date, dayOff, remarks: null,
    ...(dayOff ? {} : { shift_start: def.shift_start, am_break_start: def.am_break_start, lunch_start: def.lunch_start, lunch_end: def.lunch_end, pm_break_start: def.pm_break_start, shift_end: def.shift_end }),
  }, def.breakMinutes);
};

/** The schedule of one employee for one date: what HR plotted, else the company default. */
export async function scheduleFor(employeeId, date, trx = null) {
  const def = await defaults();
  const row = await selectOne("SELECT * FROM schedule_days WHERE employee_id = ? AND work_date = ?", [employeeId, String(date).slice(0, 10)], trx);
  return row ? fromRow(row, def.breakMinutes) : fromDefault(String(date).slice(0, 10), def);
}

/** Every day of a range: Map date → schedule. */
export async function schedulesBetween(employeeId, start, end, trx = null) {
  const def = await defaults();
  const rows = await select("SELECT * FROM schedule_days WHERE employee_id = ? AND work_date BETWEEN ? AND ?", [employeeId, start, end], trx);
  const byDate = new Map(rows.map((r) => [String(r.work_date).slice(0, 10), r]));
  const out = new Map();
  for (let d = parse(start); d <= parse(end); d.setDate(d.getDate() + 1)) {
    const day = iso(d);
    out.set(day, byDate.has(day) ? fromRow(byDate.get(day), def.breakMinutes) : fromDefault(day, def));
  }
  return out;
}

export const isDayOff = (sched) => !!sched.dayOff;

/** Days off in a range, as a Set of dates (used by leave, attendance encoding and payroll). */
export async function daysOffBetween(employeeId, start, end, trx = null) {
  const all = await schedulesBetween(employeeId, String(start).slice(0, 10), String(end).slice(0, 10), trx);
  return new Set([...all].filter(([, s]) => s.dayOff).map(([d]) => d));
}

/** One employee's month as a calendar (weeks Monday → Sunday) with the selected day in full. */
export async function monthView(employeeId, month, selected) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1), last = new Date(y, m, 0);
  const gridStart = new Date(first); gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const gridEnd = new Date(last); gridEnd.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
  const s = iso(gridStart), e = iso(gridEnd);
  const [scheds, holidays, leaves, overtime, attendance] = await Promise.all([
    schedulesBetween(employeeId, s, e),
    select("SELECT holiday_date, name, holiday_type FROM holidays WHERE is_active = 1 AND holiday_date BETWEEN ? AND ?", [s, e]),
    select(`SELECT l.application_no, l.start_date, l.end_date, l.days, l.status, t.name AS type_name FROM leave_applications l JOIN leave_types t ON t.id = l.leave_type_id
             WHERE l.employee_id = ? AND l.status IN ('approved','pending') AND l.start_date <= ? AND l.end_date >= ?`, [employeeId, e, s]),
    select(`SELECT id, request_no, work_date, start_time, end_time, hours, ot_type, status, approver_name FROM overtime_records
             WHERE employee_id = ? AND status IN ('approved','pending') AND work_date BETWEEN ? AND ? ORDER BY work_date, start_time`, [employeeId, s, e]),
    select(`SELECT work_date, status, time_in, time_out, hours_worked, late_minutes, undertime_minutes, overbreak_minutes, validation_status
              FROM attendance_records WHERE employee_id = ? AND work_date BETWEEN ? AND ?`, [employeeId, s, e]),
  ]);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  const sel = /^\d{4}-\d{2}-\d{2}$/.test(selected || "") && selected >= s && selected <= e ? selected : (today >= iso(first) && today <= iso(last) ? today : iso(first));
  const cells = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    const day = iso(d);
    const sched = scheds.get(day);
    const hol = holidays.find((h) => String(h.holiday_date).slice(0, 10) === day) || null;
    const leave = leaves.find((l) => String(l.start_date).slice(0, 10) <= day && String(l.end_date).slice(0, 10) >= day) || null;
    const ot = overtime.filter((o) => String(o.work_date).slice(0, 10) === day)
      .map((o) => ({ ...o, start: hhmm(o.start_time), end: hhmm(o.end_time), hours: Number(o.hours), approved: o.status === "approved" }));
    const att = attendance.find((a) => String(a.work_date).slice(0, 10) === day) || null;
    const approvedOt = ot.filter((o) => o.approved);
    const otEnd = approvedOt.map((o) => o.end).filter(Boolean).sort().pop() || null;
    cells.push({
      date: day, dayNo: d.getDate(), short: DAY_NAMES[d.getDay()].slice(0, 3), name: DAY_NAMES[d.getDay()],
      label: d.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
      inMonth: d.getMonth() === m - 1, today: day === today, selected: day === sel,
      sched, holiday: hol, nonWorkingHoliday: !!(hol && hol.holiday_type !== "special_working"), leave, ot,
      approvedOtHours: approvedOt.reduce((a, o) => a + o.hours, 0),
      endsAt: !sched.dayOff && otEnd && otEnd > sched.shift_end ? otEnd : null,
      attendance: att ? { ...att, time_in: hhmm(att.time_in), time_out: hhmm(att.time_out) } : null,
    });
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const inMonth = cells.filter((c) => c.inMonth);
  const prev = new Date(y, m - 2, 1), next = new Date(y, m, 1);
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  // the open page reloads when this changes: an overtime or leave decision, or HR re-plotting a day
  const stamp = JSON.stringify([overtime.map((o) => [o.id, o.status]), leaves.map((l) => [l.application_no, l.status]), [...scheds.values()].map((x) => [x.source, x.dayOff, x.shift_start, x.shift_end, x.lunch_start, x.am_break_start, x.pm_break_start])]);
  return {
    month, monthLabel: first.toLocaleDateString("en-PH", { month: "long", year: "numeric" }), prev: ym(prev), next: ym(next),
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], weeks, day: cells.find((c) => c.selected), stamp,
    summary: {
      workDays: inMonth.filter((c) => !c.sched.dayOff && !c.nonWorkingHoliday).length,
      daysOff: inMonth.filter((c) => c.sched.dayOff).length,
      otHours: inMonth.reduce((a, c) => a + c.approvedOtHours, 0),
      plotted: inMonth.filter((c) => c.sched.source === "hr").length,
    },
  };
}

// ---- Payroll Staff / Accounting Supervisor: the week's roster as HR plotted it -------------------------------------------------
export async function weekRoster(start, q = "") {
  const monday = parse(start); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const like = `%${String(q).trim()}%`;
  const emps = await select(
    `SELECT e.id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department
       FROM employees e JOIN departments d ON d.id = e.department_id
      WHERE e.deleted_at IS NULL AND e.employment_status IN ('active','on_leave')
        AND (? = '%%' OR e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ?)
      ORDER BY d.name, e.last_name, e.first_name`, [like, like, like, like]);
  const days = [];
  for (let d = new Date(monday); d <= sunday; d.setDate(d.getDate() + 1)) days.push({ date: iso(d), short: DAY_NAMES[d.getDay()].slice(0, 3), dayNo: d.getDate() });
  const rows = [];
  for (const e of emps) {
    const all = await schedulesBetween(e.id, iso(monday), iso(sunday));
    rows.push({ ...e, name: fullName(e), days: days.map((d) => all.get(d.date)), plotted: [...all.values()].some((s) => s.source === "hr") });
  }
  const prev = new Date(monday); prev.setDate(monday.getDate() - 7);
  const next = new Date(monday); next.setDate(monday.getDate() + 7);
  return { days, rows, monday: iso(monday), prev: iso(prev), next: iso(next), q,
    label: `${monday.toLocaleDateString("en-PH", { month: "short", day: "numeric" })} – ${sunday.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}` };
}

/** The company default for a date (used when no employee is involved). */
export async function defaultFor(date) { return fromDefault(String(date).slice(0, 10), await defaults()); }
/** The default days off (0 = Sunday … 6 = Saturday), for calendars that cover everyone. */
export async function defaultRestDays() { return (await defaults()).restDays; }
