// Time clock (Employee Self-Service). A work day has up to eight punches, in order:
//   morning in → [morning break start → morning break end] → morning out → (one-hour lunch) →
//   afternoon in → [afternoon break start → afternoon break end] → afternoon out
// The day follows the schedule HR plotted (scheduleService). Breaks are 15 minutes and paid; lunch is unpaid. Employees
// must punch out and back in for every break and for lunch: every minute past the plotted break or lunch — including
// forgetting to punch back in — is lost time, deducted from pay and shown on the payslip as lost hours.
// Every punch recomputes the day's attendance record (source 'punch'), which Payroll Staff validate before payroll uses it.
import { select, selectOne, exec, tx } from "../lib/db.js";
import { getSetting } from "../lib/settings.js";
import { audit } from "../lib/audit.js";
import { badRequest, forbidden } from "../lib/errors.js";
import { scheduleFor, isDayOff } from "./scheduleService.js";

export const PUNCHES = [
  { type: "am_in", label: "Morning in", session: "am" },
  { type: "am_break_start", label: "Morning break start", session: "am", isBreak: true },
  { type: "am_break_end", label: "Morning break end", session: "am", isBreak: true },
  { type: "am_out", label: "Morning out (lunch)", session: "am" },
  { type: "pm_in", label: "Afternoon in", session: "pm" },
  { type: "pm_break_start", label: "Afternoon break start", session: "pm", isBreak: true },
  { type: "pm_break_end", label: "Afternoon break end", session: "pm", isBreak: true },
  { type: "pm_out", label: "Afternoon out", session: "pm" },
];
export const PUNCH_LABEL = Object.fromEntries(PUNCHES.map((p) => [p.type, p.label]));
// the plotted time each punch is expected at
const PLANNED = { am_in: "shift_start", am_break_start: "am_break_start", am_break_end: "am_break_end", am_out: "lunch_start",
  pm_in: "lunch_end", pm_break_start: "pm_break_start", pm_break_end: "pm_break_end", pm_out: "shift_end" };

const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** Asia/Manila wall-clock now: { date: 'YYYY-MM-DD', time: 'HH:MM:SS' }. */
export function manilaNow(now = new Date()) {
  const s = now.toLocaleString("sv-SE", { timeZone: "Asia/Manila" });
  return { date: s.slice(0, 10), time: s.slice(11, 19) };
}

/** Which punches may come next, given those already made today (pure; exported for unit tests). */
export function nextPunches(done) {
  const has = (t) => done.has(t);
  const session = (p) => {
    if (!has(`${p}_in`)) return null;
    if (has(`${p}_out`)) return [];
    if (has(`${p}_break_start`) && !has(`${p}_break_end`)) return [`${p}_break_end`];
    return has(`${p}_break_start`) ? [`${p}_out`] : [`${p}_break_start`, `${p}_out`];
  };
  const am = session("am"), pm = session("pm");
  if (pm !== null) return pm;                 // the afternoon has started: the morning is closed
  if (am === null) return ["am_in", "pm_in"]; // nothing yet (pm_in = afternoon-only half day)
  return am.length ? am : ["pm_in"];
}

/**
 * The day's attendance from its punches (pure; exported for unit tests).
 * punches: { am_in: 'HH:MM', … }; sched: the plotted day { shift_start, am_break_start, am_break_end, lunch_start, lunch_end,
 * pm_break_start, pm_break_end, shift_end }; cfg: { grace, shortBreak, hoursPerDay }; kind: 'work' | 'rest_day' | 'holiday'.
 *  • Breaks are paid, lunch is not. Every minute past a break or lunch is lost time (overbreak_minutes): the longer of
 *    "more than 15 minutes / the plotted lunch length" and "back after the plotted end" — e.g. forgetting to punch back in.
 *  • Late = arriving after the shift start (beyond the grace period); undertime = leaving before the shift end.
 *  • A day with only the morning or only the afternoon worked is a half day.
 */
export function computeFromPunches(punches, sched, cfg, kind = "work") {
  const m = Object.fromEntries(Object.entries(punches).map(([k, v]) => [k, toMin(v)]));
  const P = (k) => (sched && sched[k] ? toMin(sched[k]) : null);
  const am = m.am_in != null && m.am_out != null ? m.am_out - m.am_in : 0;
  const pm = m.pm_in != null && m.pm_out != null ? m.pm_out - m.pm_in : 0;
  const over = (start, end, allowed, plannedEnd) => {
    if (start == null || end == null) return 0;
    return Math.max(0, end - start - allowed, plannedEnd == null ? 0 : end - plannedEnd);
  };
  const lunchAllowed = P("lunch_start") != null && P("lunch_end") != null ? P("lunch_end") - P("lunch_start") : 60;
  const amBreak = over(m.am_break_start, m.am_break_end, cfg.shortBreak, P("am_break_end"));
  const pmBreak = over(m.pm_break_start, m.pm_break_end, cfg.shortBreak, P("pm_break_end"));
  const lunch = over(m.am_out, m.pm_in, lunchAllowed, P("lunch_end"));
  const lost = amBreak + pmBreak + lunch;
  // break minutes past the allowance are not paid (lunch is outside the morning and afternoon sessions anyway)
  const worked = Math.max(0, am + pm - amBreak - pmBreak);
  const hours = Math.round(Math.min(worked / 60, cfg.hoursPerDay) * 100) / 100;
  const timeIn = m.am_in ?? m.pm_in;
  const timeOut = m.pm_out ?? m.am_out;
  const missing = [];
  if (am > 0 && m.am_break_start == null) missing.push("morning break");
  if (pm > 0 && m.pm_break_start == null) missing.push("afternoon break");
  const base = {
    time_in: timeIn != null ? fromMin(timeIn) : null, time_out: timeOut != null ? fromMin(timeOut) : null, hours_worked: hours,
    overbreak_minutes: lost, lost: { am_break: amBreak, lunch, pm_break: pmBreak },
    remarks: missing.length ? `Not punched: ${missing.join(", ")}` : null,
  };
  if (kind !== "work") return { ...base, status: kind, late_minutes: 0, undertime_minutes: 0 };

  let late = 0, undertime = 0;
  if (m.am_in != null) { const raw = m.am_in - P("shift_start"); if (raw > cfg.grace) late = raw; }
  else if (m.pm_in != null) { const raw = m.pm_in - P("lunch_end"); if (raw > cfg.grace) late = raw; } // afternoon-only half day
  const amDone = am > 0, pmDone = pm > 0;
  if (amDone && pmDone) undertime = Math.max(0, P("shift_end") - m.pm_out);
  const status = amDone && pmDone ? (late > 0 ? "late" : "present") : amDone || pmDone ? "half_day" : late > 0 ? "late" : "present";
  return { ...base, status, late_minutes: late, undertime_minutes: undertime };
}

async function clockConfig() {
  return {
    grace: Number(await getSetting("attendance.grace_minutes", 10)),
    shortBreak: Number(await getSetting("attendance.short_break_minutes", 15)),
    hoursPerDay: Number(await getSetting("attendance.hours_per_day", 8)),
  };
}

/** Today's clock for the signed-in employee. */
export async function today(employeeId) {
  const now = manilaNow();
  const sched = await scheduleFor(employeeId, now.date);
  const rows = await select("SELECT punch_type, DATE_FORMAT(punched_at, '%H:%i') AS at FROM attendance_punches WHERE employee_id = ? AND work_date = ? ORDER BY punched_at, id", [employeeId, now.date]);
  const done = new Set(rows.map((r) => r.punch_type));
  const allowed = nextPunches(done);
  const record = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ?", [employeeId, now.date]);
  const holiday = await selectOne("SELECT name, holiday_type FROM holidays WHERE holiday_date = ? AND is_active = 1", [now.date]);
  const emp = await selectOne("SELECT employment_status FROM employees WHERE id = ?", [employeeId]);
  const leave = await selectOne(
    `SELECT l.application_no, l.days, t.name FROM leave_applications l JOIN leave_types t ON t.id = l.leave_type_id
      WHERE l.employee_id = ? AND l.status = 'approved' AND ? BETWEEN l.start_date AND l.end_date LIMIT 1`, [employeeId, now.date]);
  const history = await select(
    `SELECT a.work_date, a.status, a.time_in, a.time_out, a.late_minutes, a.undertime_minutes, a.overbreak_minutes, a.hours_worked, a.validation_status,
            GROUP_CONCAT(CONCAT(p.punch_type, '=', DATE_FORMAT(p.punched_at, '%H:%i')) ORDER BY p.punched_at SEPARATOR ',') AS punches
       FROM attendance_records a LEFT JOIN attendance_punches p ON p.employee_id = a.employee_id AND p.work_date = a.work_date
      WHERE a.employee_id = ? AND a.work_date >= DATE_SUB(?, INTERVAL 13 DAY) AND a.work_date < ?
      GROUP BY a.id ORDER BY a.work_date DESC`, [employeeId, now.date, now.date]);
  return {
    date: now.date, time: now.time.slice(0, 5), schedule: sched,
    active: !!emp && ["active", "on_leave"].includes(emp.employment_status), employmentStatus: emp?.employment_status || null,
    dayOff: isDayOff(sched), holiday, leave,
    punches: PUNCHES.map((p) => {
      const row = rows.find((r) => r.punch_type === p.type);
      return { ...p, at: row ? row.at : null, planned: sched.dayOff ? null : sched[PLANNED[p.type]], allowed: allowed.includes(p.type) };
    }),
    allowed: PUNCHES.filter((p) => allowed.includes(p.type)),
    finished: allowed.length === 0,
    record,
    history: history.map((h) => ({
      ...h, time_in: String(h.time_in || "").slice(0, 5), time_out: String(h.time_out || "").slice(0, 5),
      punchList: (h.punches || "").split(",").filter(Boolean).map((x) => { const [t, at] = x.split("="); return { label: PUNCH_LABEL[t], at }; }),
    })),
  };
}

/** Records one punch for the signed-in employee, now. */
export async function punch(req, type) {
  const employeeId = req.user.employee_id;
  if (!PUNCH_LABEL[type]) throw badRequest("Unknown punch.");
  const now = manilaNow();
  const cfg = await clockConfig();
  return tx(async (trx) => {
    const emp = await selectOne("SELECT id, employment_status, date_hired FROM employees WHERE id = ? FOR UPDATE", [employeeId], trx);
    if (!emp || !["active", "on_leave"].includes(emp.employment_status)) throw badRequest(`The time clock is for active employees. Your HR record says ${emp ? emp.employment_status.replace("_", " ") : "no employee record"}; ask HR to correct it if this is wrong.`);
    const leave = await selectOne(
      "SELECT application_no, days FROM leave_applications WHERE employee_id = ? AND status = 'approved' AND ? BETWEEN start_date AND end_date LIMIT 1", [employeeId, now.date], trx);
    if (leave && Number(leave.days) !== 0.5) throw badRequest(`You are on approved leave today (${leave.application_no}).`);
    const rec = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ? FOR UPDATE", [employeeId, now.date], trx);
    if (rec?.validation_status === "locked") throw badRequest("Today's attendance is already in finalized payroll.");
    const rows = await select("SELECT punch_type, DATE_FORMAT(punched_at, '%H:%i') AS t FROM attendance_punches WHERE employee_id = ? AND work_date = ?", [employeeId, now.date], trx);
    const done = new Set(rows.map((r) => r.punch_type));
    if (done.has(type)) throw badRequest(`${PUNCH_LABEL[type]} was already recorded today.`);
    const allowed = nextPunches(done);
    if (!allowed.includes(type)) throw badRequest(`${PUNCH_LABEL[type]} is not the next step. Next: ${allowed.map((t) => PUNCH_LABEL[t]).join(" or ") || "nothing — your day is complete"}.`);
    const last = rows.map((r) => r.t).sort().pop();
    if (last && now.time.slice(0, 5) < last) throw badRequest("The clock is earlier than your last punch. Contact Payroll Staff.");

    await exec("INSERT INTO attendance_punches (employee_id, work_date, punch_type, punched_at, ip_address) VALUES (?,?,?,?,?)",
      [employeeId, now.date, type, `${now.date} ${now.time}`, String(req.ip || "").slice(0, 45) || null], trx);

    const punches = Object.fromEntries(rows.map((r) => [r.punch_type, r.t]));
    punches[type] = now.time.slice(0, 5);
    const sched = await scheduleFor(employeeId, now.date, trx);
    const holiday = await selectOne("SELECT holiday_type FROM holidays WHERE holiday_date = ? AND is_active = 1", [now.date], trx);
    const kind = holiday && holiday.holiday_type !== "special_working" ? "holiday" : isDayOff(sched) ? "rest_day" : "work";
    const d = computeFromPunches(punches, sched, cfg, kind);
    // in and out within the same minute: keep the time in only (the record may not have equal in and out times)
    if (d.time_out && d.time_out === d.time_in) d.time_out = null;
    if (rec) {
      await exec(
        `UPDATE attendance_records SET status = ?, time_in = ?, time_out = ?, late_minutes = ?, undertime_minutes = ?, overbreak_minutes = ?, hours_worked = ?,
                remarks = ?, source = 'punch', validation_status = 'pending', validated_by = NULL, validated_at = NULL WHERE id = ?`,
        [d.status, d.time_in, d.time_out, d.late_minutes, d.undertime_minutes, d.overbreak_minutes, d.hours_worked, d.remarks, rec.id], trx);
    } else {
      await exec(
        `INSERT INTO attendance_records (employee_id, work_date, time_in, time_out, status, late_minutes, undertime_minutes, overbreak_minutes, hours_worked, remarks, source, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'punch', ?)`,
        [employeeId, now.date, d.time_in, d.time_out, d.status, d.late_minutes, d.undertime_minutes, d.overbreak_minutes, d.hours_worked, d.remarks, req.user.id], trx);
    }
    await audit(req, { action: "time_punch", module: "attendance", recordType: "employee", recordId: employeeId,
      next: { date: now.date, punch: type, at: now.time.slice(0, 5), status: d.status, late: d.late_minutes, undertime: d.undertime_minutes, lost: d.overbreak_minutes, hours: d.hours_worked } }, trx);
    return { label: PUNCH_LABEL[type], at: now.time.slice(0, 5), day: d };
  });
}

/** Punch log for Payroll Staff: one employee-day. */
export async function punchesFor(employeeId, date) {
  return select("SELECT punch_type, DATE_FORMAT(punched_at, '%H:%i:%s') AS at, ip_address FROM attendance_punches WHERE employee_id = ? AND work_date = ? ORDER BY punched_at, id", [employeeId, date])
    .then((r) => r.map((p) => ({ ...p, label: PUNCH_LABEL[p.punch_type] })));
}
