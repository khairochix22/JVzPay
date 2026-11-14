// My Schedule page (GET /my/schedule?month=YYYY-MM&date=YYYY-MM-DD, GET /my/schedule/live): a month calendar of the
// schedule HR plotted — work days, days off, holidays, leave and overtime. Clicking a day shows that day in full: start of
// shift, morning break, lunch, afternoon break, end of shift, overtime and the punches made. Approved overtime and HR
// re-plotting show up by themselves: the page asks /my/schedule/live every 30 seconds and reloads when the month changed.
import { wrap } from "../../lib/errors.js";
import { monthView } from "../../services/scheduleService.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const pickMonth = (q, date) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(q || "") ? q : /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date.slice(0, 7) : today().slice(0, 7));

export const page = wrap(async (req, res) => {
  const view = await monthView(req.user.employee_id, pickMonth(req.query.month, req.query.date), String(req.query.date || ""));
  res.render("my-schedule", { title: "My Schedule", ...view, stampHash: hash(view.stamp) });
});

export const live = wrap(async (req, res) => {
  const view = await monthView(req.user.employee_id, pickMonth(req.query.month), "");
  res.set("Cache-Control", "no-store").json({ stamp: hash(view.stamp) });
});

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
