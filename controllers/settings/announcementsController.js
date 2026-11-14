// Announcements page (GET/POST /settings/announcements): shown on dashboards and sent as notifications.
import { wrap, action, badRequest } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listAnnouncements, publishAnnouncement, withdrawAnnouncement } from "../../services/adminService.js";

export const page = wrap(async (req, res) => {
  res.render("announcements", { title: "Announcements", rows: await listAnnouncements() });
});

export const publish = action(async (req) => {
  const { values, errors, ok } = validate(req.body, {
    title: { label: "Title", required: true, max: 160 },
    body: { label: "Message", required: true, max: 2000 },
    audience: { label: "Audience", type: "enum", values: ["all", "staff", "employees"], required: true },
    expires_at: { label: "Show until", type: "date" },
  });
  if (!ok) throw badRequest(Object.values(errors).join(" "));
  const n = await publishAnnouncement(req, values);
  return `Announcement published and sent to ${n} user(s).`;
}, "/settings/announcements");

export const withdraw = action(async (req) => {
  const a = await withdrawAnnouncement(req, Number(req.params.id));
  return `“${a.title}” was withdrawn.`;
}, "/settings/announcements");
