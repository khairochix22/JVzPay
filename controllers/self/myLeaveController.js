/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// My Leave page (GET /my/leave): credits, applications (with optional document), cancellation, and the year-end cash
// conversion of unused vacation leave (POST /my/leave/conversion, POST /my/leave/conversion/:id/cancel).
import { wrap, action, HttpError } from "../../lib/errors.js";
import * as leave from "../../services/leaveService.js";
import { myConversion, requestConversion, cancelConversion } from "../../services/leaveConversionService.js";

const isUserError = (e) => e instanceof HttpError && e.status < 500;

async function leavePage(req, res, extra = {}, status = 200) {
  const year = new Date().getFullYear();
  const [credits, applications, types, conversion] = await Promise.all([leave.balances(req.user.employee_id, year), leave.myApplications(req.user.employee_id), leave.activeTypes(), myConversion(req.user.employee_id)]);
  res.status(status).render("my-leave", { title: "My Leave", year, credits, applications, types, conversion, form: {}, errors: {}, today: leave.todayIso(), ...extra });
}

export const showLeave = wrap((req, res) => leavePage(req, res));

export const applyLeave = wrap(async (req, res) => {
  const { values, errors } = leave.validateApplication(req.body);
  if (req.uploadError) errors.attachment = req.uploadError;
  if (Object.keys(errors).length) return leavePage(req, res, { form: values, errors, showForm: true }, 422);
  try {
    const { no, days } = await leave.apply(req, values, req.file);
    req.flash("success_msg", `Leave application ${no} (${days} day${days === 1 ? "" : "s"}) was submitted for approval.`);
    res.redirect("/my/leave");
  } catch (e) {
    if (!isUserError(e)) throw e;
    return leavePage(req, res, { form: values, errors: { form: e.message }, showForm: true }, e.status);
  }
});

export const cancelLeave = wrap(async (req, res) => {
  await leave.cancel(req, Number(req.params.id));
  req.flash("success_msg", "Leave application cancelled. The reserved days were returned to your balance.");
  res.redirect("/my/leave");
});

export const convert = action(async (req) => {
  const r = await requestConversion(req);
  return `${r.no}: ${r.days} day(s) of ${r.year} vacation leave (₱${r.amount}) were sent for approval.`;
}, "/my/leave");

export const cancelConversionRequest = action(async (req) => {
  await cancelConversion(req, Number(req.params.id));
  return "Conversion request cancelled. The days are back in your balance.";
}, "/my/leave");
