/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// My Attendance page (GET /my/attendance): own time records, summary, and correction requests.
import { wrap, HttpError } from "../../lib/errors.js";
import * as leave from "../../services/leaveService.js";
import * as att from "../../services/correctionService.js";

const isUserError = (e) => e instanceof HttpError && e.status < 500;

async function attendancePage(req, res, extra = {}, status = 200) {
  const data = await att.myAttendance(req.user.employee_id, req.query.month);
  res.status(status).render("my-attendance", {
    title: "My Attendance", ...data, statuses: att.REQUESTABLE_STATUSES, today: leave.todayIso(),
    form: { work_date: req.query.date || "", requested_status: "present" }, errors: {}, ...extra,
  });
}

export const showAttendance = wrap((req, res) => attendancePage(req, res, { showForm: !!req.query.date }));

export const requestCorrection = wrap(async (req, res) => {
  const { values, errors } = att.validateCorrection(req.body);
  if (req.uploadError) errors.attachment = req.uploadError;
  if (Object.keys(errors).length) return attendancePage(req, res, { form: values, errors, showForm: true }, 422);
  try {
    const { no } = await att.requestCorrection(req, values, req.file);
    req.flash("success_msg", `Correction request ${no} was submitted to the Accounting Supervisor.`);
    res.redirect(`/my/attendance?month=${values.work_date.slice(0, 7)}`);
  } catch (e) {
    if (!isUserError(e)) throw e;
    return attendancePage(req, res, { form: values, errors: { form: e.message }, showForm: true }, e.status);
  }
});

export const cancelCorrection = wrap(async (req, res) => {
  await att.cancelCorrection(req, Number(req.params.id));
  req.flash("success_msg", "Correction request cancelled.");
  res.redirect("/my/attendance");
});
