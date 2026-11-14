// My Government Enrollment page (GET /my/government, POST requests, POST cancel): SSS, PhilHealth, Pag-IBIG MID and TIN,
// shown masked; new or changed numbers wait for Payroll Staff to verify them.
import { wrap, HttpError } from "../../lib/errors.js";
import * as svc from "../../services/enrollmentService.js";

async function render(req, res, extra = {}, status = 200) {
  res.status(status).render("my-government", { title: "Government Enrollment", ...(await svc.myGovernment(req.user.employee_id)), gov: svc.GOV, form: {}, errors: {}, ...extra });
}

export const page = wrap((req, res) => render(req, res));

export const submit = wrap(async (req, res) => {
  const { values, errors } = svc.checkGovernment(req.body);
  if (req.uploadError) errors.attachment = req.uploadError;
  if (Object.keys(errors).length) return render(req, res, { errors }, 422); // numbers are never echoed back
  try {
    const no = await svc.submitGovernment(req, values, req.file);
    req.flash("success_msg", `${no} was submitted. Payroll uses the new numbers once Payroll Staff verify them.`);
    res.redirect("/my/government");
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return render(req, res, { errors: { form: e.message } }, e.status);
    throw e;
  }
});

export const cancel = wrap(async (req, res) => {
  await svc.cancelOwn(req, "statutory", Number(req.params.id));
  req.flash("success_msg", "Request cancelled.");
  res.redirect("/my/government");
});
