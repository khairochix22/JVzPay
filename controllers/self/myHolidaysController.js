// Holiday Calendar page (GET /my/holidays): company, regular and special non-working days for a year, with the
// employee's own work schedule and two days off.
import { wrap } from "../../lib/errors.js";
import { select } from "../../lib/db.js";
import { scheduleFor } from "../../services/scheduleService.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TYPE_LABEL = { regular: "Regular holiday", special_non_working: "Special non-working day", special_working: "Special working day", company: "Company holiday", local: "Local holiday" };

export const page = wrap(async (req, res) => {
  const now = new Date().getFullYear();
  const year = Number(req.query.year) >= 2000 && Number(req.query.year) <= 2100 ? Number(req.query.year) : now;
  const rows = await select("SELECT holiday_date, name, holiday_type FROM holidays WHERE is_active = 1 AND YEAR(holiday_date) = ? ORDER BY holiday_date", [year]);
  const today = new Date().toISOString().slice(0, 10);
  const holidays = rows.map((h) => {
    const d = h.holiday_date instanceof Date ? h.holiday_date : new Date(`${h.holiday_date}T00:00:00`);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { ...h, iso, weekday: DAYS[d.getDay()], typeLabel: TYPE_LABEL[h.holiday_type] || h.holiday_type, past: iso < today, month: d.toLocaleString("en-PH", { month: "long" }) };
  });
  const months = [];
  for (const h of holidays) { const m = months.find((x) => x.name === h.month); if (m) m.items.push(h); else months.push({ name: h.month, items: [h] }); }
  const sched = await scheduleFor(req.user.employee_id, today);
  res.render("my-holidays", {
    title: "Holiday Calendar", year, prev: year - 1, next: year + 1, months, count: holidays.length,
    upcoming: holidays.find((h) => !h.past) || null,
    schedule: { dayOff: sched.dayOff, start: sched.shift_start, end: sched.shift_end, lunch: `${sched.lunch_start}–${sched.lunch_end}`, source: sched.source },
  });
});
