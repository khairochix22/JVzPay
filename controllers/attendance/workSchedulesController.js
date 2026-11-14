// Work Schedules page (GET /attendance/schedules?week=YYYY-MM-DD): the week's roster as HR plotted it — each employee's
// shift or day off per day. Schedules are plotted in the HR system and arrive through the integration
// (ScheduleDaysPlotted); days HR has not plotted follow the company default from System Settings.
import { wrap } from "../../lib/errors.js";
import { weekRoster } from "../../services/scheduleService.js";

export const page = wrap(async (req, res) => {
  const week = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || "") ? req.query.week : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  res.render("work-schedules", { title: "Work Schedules", ...(await weekRoster(week, String(req.query.q || "").slice(0, 80))) });
});
