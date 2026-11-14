// Time Clock page (GET /my/clock, POST /my/clock/punch): the employee punches morning in, the morning break (start and
// end), morning out, afternoon in, the afternoon break and afternoon out. Each punch updates today's attendance record.
import { action, wrap } from "../../lib/errors.js";
import { today, punch as recordPunch } from "../../services/timeClockService.js";

export const page = wrap(async (req, res) => {
  res.render("my-clock", { title: "Time Clock", ...(await today(req.user.employee_id)) });
});

export const punch = action(async (req) => {
  const r = await recordPunch(req, String(req.body.punch_type || ""));
  return `${r.label} recorded at ${r.at}.`;
}, "/my/clock");
