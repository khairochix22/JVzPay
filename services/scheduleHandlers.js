// ScheduleDaysPlotted from HR: HR plots each employee's schedule day by day — shift, morning and afternoon breaks,
// lunch, end of shift, or a day off — and can re-plot any day later. JVzPay keeps the latest plot per employee and date;
// "clear": true returns a day to the company default. Days already in finalized payroll cannot be re-plotted.
import { selectOne, exec } from "../lib/db.js";
import { notifyEmployee } from "../lib/notify.js";
import { registerHandlers, eventFail as fail, eventNeed as need, eventIsDate as isDate, eventStr as str } from "./integrationService.js";


const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const FIELDS = ["shift_start", "am_break_start", "lunch_start", "lunch_end", "pm_break_start", "shift_end"];

/** Checks one plotted day (pure; exported for unit tests). Returns the row values or throws with the reason. */
export function checkPlottedDay(day, breakMinutes = 15) {
  if (!day || typeof day !== "object") throw new Error("each day must be an object");
  if (!isDate(day.date)) throw new Error("date must be YYYY-MM-DD");
  if (day.clear === true) return { date: day.date, clear: true };
  if (day.day_off === true) return { date: day.date, is_day_off: 1, remarks: str(day.remarks, 255) || null };
  for (const f of FIELDS) if (!TIME.test(String(day[f] ?? ""))) throw new Error(`${day.date}: ${f} must be HH:MM (or send "day_off": true)`);
  const t = Object.fromEntries(FIELDS.map((f) => [f, toMin(day[f])]));
  if (!(t.shift_start < t.am_break_start && t.am_break_start + breakMinutes <= t.lunch_start && t.lunch_start < t.lunch_end
    && t.lunch_end < t.pm_break_start && t.pm_break_start + breakMinutes <= t.shift_end)) {
    throw new Error(`${day.date}: times must run shift start → morning break → lunch → afternoon break → shift end`);
  }
  const work = t.shift_end - t.shift_start - (t.lunch_end - t.lunch_start);
  if (work < 60 || work > 12 * 60) throw new Error(`${day.date}: a shift of ${Math.round(work / 6) / 10} working hours is not accepted`);
  return { date: day.date, is_day_off: 0, ...Object.fromEntries(FIELDS.map((f) => [f, day[f]])), remarks: str(day.remarks, 255) || null };
}

async function schedulePlotted(d, e, trx) {
  need(d, ["employee_id", "days"]);
  if (!Array.isArray(d.days) || !d.days.length) fail("data.days must be a non-empty list.");
  if (d.days.length > 62) fail("Send at most 62 days per event.");
  const emp = await selectOne("SELECT id, employee_no FROM employees WHERE hr_employee_id = ?", [str(d.employee_id, 40)], trx);
  if (!emp) fail(`Employee ${d.employee_id} is not in JVzPay yet. Send EmployeeCreated first.`);
  const rows = [];
  for (const day of d.days) {
    try { rows.push(checkPlottedDay(day)); } catch (err) { fail(err.message); }
  }
  for (const r of rows) {
    const locked = await selectOne("SELECT id FROM attendance_records WHERE employee_id = ? AND work_date = ? AND validation_status = 'locked'", [emp.id, r.date], trx);
    if (locked) fail(`${r.date} is already in finalized payroll and cannot be re-plotted.`);
  }
  let plotted = 0, cleared = 0;
  for (const r of rows) {
    if (r.clear) { await exec("DELETE FROM schedule_days WHERE employee_id = ? AND work_date = ?", [emp.id, r.date], trx); cleared++; continue; }
    await exec(
      `INSERT INTO schedule_days (employee_id, work_date, is_day_off, shift_start, am_break_start, lunch_start, lunch_end, pm_break_start, shift_end, remarks, hr_event_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE is_day_off = VALUES(is_day_off), shift_start = VALUES(shift_start), am_break_start = VALUES(am_break_start),
         lunch_start = VALUES(lunch_start), lunch_end = VALUES(lunch_end), pm_break_start = VALUES(pm_break_start), shift_end = VALUES(shift_end),
         remarks = VALUES(remarks), hr_event_id = VALUES(hr_event_id)`,
      [emp.id, r.date, r.is_day_off, r.shift_start ?? null, r.am_break_start ?? null, r.lunch_start ?? null, r.lunch_end ?? null, r.pm_break_start ?? null, r.shift_end ?? null, r.remarks, str(e.event_id, 64)], trx);
    plotted++;
  }
  const dates = rows.map((r) => r.date).sort();
  await notifyEmployee(emp.id, {
    type: "schedule_plotted", title: "HR updated your schedule",
    message: dates.length === 1 ? `Your schedule for ${dates[0]} was updated.` : `Your schedule from ${dates[0]} to ${dates[dates.length - 1]} was updated.`,
    relatedType: "employee", relatedId: emp.id, link: `/my/schedule?month=${dates[0].slice(0, 7)}&date=${dates[0]}`,
  }, trx);
  return `${emp.employee_no}: ${plotted} day(s) plotted${cleared ? `, ${cleared} back to the default` : ""}`;
}

registerHandlers("johnvivz_hr", { ScheduleDaysPlotted: schedulePlotted });
