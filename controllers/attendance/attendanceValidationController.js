/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Validate Attendance page (GET/POST /attendance/validation): only validated attendance is used by payroll (attendance.validate).
import { wrap, HttpError } from "../../lib/errors.js";
import { pendingForValidation, validateRecords } from "../../services/attendanceService.js";
import { lookups } from "../../services/employeeService.js";

export const validationQueue = wrap(async (req, res) => {
  const data = await pendingForValidation(req);
  const { departments } = await lookups();
  res.render("attendance-validation", { title: "Validate Attendance", ...data, departments });
});

export const validateSelected = wrap(async (req, res) => {
  const ids = [].concat(req.body.ids || []);
  try {
    const { validated, skippedOwn } = await validateRecords(req, ids);
    const own = skippedOwn ? ` ${skippedOwn} of your own record(s) were skipped — another staff member must validate them.` : "";
    req.flash("success_msg", `${validated} record(s) validated.${own}`);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    req.flash("error_msg", e.message);
  }
  res.redirect(`/attendance/validation?from=${encodeURIComponent(req.body.from || "")}&to=${encodeURIComponent(req.body.to || "")}`);
});
