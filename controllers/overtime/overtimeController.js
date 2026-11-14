/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Overtime page (GET/POST /overtime): overtime records and the encoding form for Payroll Staff (overtime.submit).
import { wrap, HttpError } from "../../lib/errors.js";
import { listOvertime, validateOvertime, submitOvertime, activeEmployees, OT_TYPES } from "../../services/overtimeService.js";

async function render(req, res, extra = {}, status = 200) {
  const data = await listOvertime(req);
  const canSubmit = req.user.can("overtime.submit");
  res.status(status).render("overtime", {
    title: "Overtime", ...data, employees: canSubmit ? await activeEmployees() : [], types: OT_TYPES,
    form: { ot_type: "regular" }, errors: {}, canSubmit, ...extra,
  });
}
export const overtimePage = wrap((req, res) => render(req, res));

export const encode = wrap(async (req, res) => {
  const { values, errors } = validateOvertime(req.body);
  if (Object.keys(errors).length) return render(req, res, { form: values, errors }, 422);
  try {
    await submitOvertime(req, values);
    req.flash("success_msg", "Overtime encoded and sent to the Accounting Supervisor for approval.");
    res.redirect("/overtime");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    await render(req, res, { form: values, errors: { form: e.message } }, e.status);
  }
});
