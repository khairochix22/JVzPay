// Payroll Adjustments page (GET/POST /payroll/adjustments): one-off corrections filed by Payroll Staff.
import { wrap, HttpError } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listAdjustments, createAdjustment, adjustmentComponents, openPeriods } from "../../services/payrollSetupService.js";
import { activeEmployees } from "../../services/overtimeService.js";

async function render(req, res, extra = {}, status = 200) {
  const canSubmit = req.user.can("payroll.adjust.submit");
  res.status(status).render("payroll-adjustments", {
    title: "Payroll Adjustments", ...(await listAdjustments(req)), canSubmit,
    employees: canSubmit ? await activeEmployees() : [], components: await adjustmentComponents(), periods: await openPeriods(), form: {}, errors: {}, ...extra,
  });
}
export const page = wrap((req, res) => render(req, res));

export const create = wrap(async (req, res) => {
  const { values, errors, ok } = validate(req.body, {
    employee_id: { label: "Employee", type: "id", required: true },
    period_id: { label: "Apply in period", type: "id", required: true },
    component_id: { label: "Component", type: "id", required: true },
    amount: { label: "Amount", type: "money", required: true, min: 0.01 },
    reason: { label: "Reason", required: true, min: 5, max: 500 },
  });
  if (!ok) return render(req, res, { form: values, errors }, 422);
  try {
    const no = await createAdjustment(req, values);
    req.flash("success_msg", `${no} was submitted for supervisor approval.`);
    res.redirect("/payroll/adjustments");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    await render(req, res, { form: values, errors: { form: e.message } }, e.status);
  }
});
