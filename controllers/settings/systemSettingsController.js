// System Settings page (GET/POST /settings): attendance, payroll, leave and company configuration.
import { wrap, action } from "../../lib/errors.js";
import { groupedSettings, saveSettings } from "../../services/adminService.js";

export const page = wrap(async (req, res) => {
  res.render("system-settings", { title: "System Settings", groups: await groupedSettings() });
});

export const save = action(async (req) => {
  const n = await saveSettings(req, req.body);
  return n ? `${n} setting(s) updated. New values apply to computations from now on.` : "No changes to save.";
}, "/settings");
