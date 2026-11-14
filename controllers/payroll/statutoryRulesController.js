// Statutory Rules page (GET/POST /payroll/setup/statutory): effective-dated SSS, PhilHealth and Pag-IBIG rules (payroll.config).
import { wrap, action, HttpError } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listRules, verifyRule, addRule } from "../../services/payrollSetupService.js";

const rate = (label) => ({ label, required: true, pattern: /^\d{1,2}(\.\d{1,4})?$/, patternMessage: `${label} must be a percentage such as 2.5.` });

async function render(req, res, extra = {}, status = 200) {
  res.status(status).render("statutory-rules", { title: "Statutory Rules", rules: await listRules(), form: {}, errors: {}, ...extra });
}
export const page = wrap((req, res) => render(req, res));

export const verify = action(async (req) => {
  const r = await verifyRule(req, Number(req.params.id));
  return `${r.agency} rule marked as verified.`;
}, "/payroll/setup/statutory");

export const add = wrap(async (req, res) => {
  const { values, errors, ok } = validate(req.body, {
    agency: { label: "Agency", type: "enum", values: ["SSS", "PHILHEALTH", "PAGIBIG"], required: true },
    effective_from: { label: "Effective from", type: "date", required: true },
    employee_rate_pct: rate("Employee rate"),
    employer_rate_pct: rate("Employer rate"),
    salary_floor: { label: "Salary floor", type: "money", required: true, min: 0 },
    salary_ceiling: { label: "Salary ceiling", type: "money", required: true, min: 0 },
    rounding_step: { label: "Rounding step", type: "money", min: 0 },
    ec_threshold: { label: "EC threshold", type: "money", min: 0 },
    ec_amount_low: { label: "EC amount (below threshold)", type: "money", min: 0 },
    ec_amount_high: { label: "EC amount (at or above)", type: "money", min: 0 },
    low_income_ceiling: { label: "Lower band salary", type: "money", min: 0 },
    low_income_employee_rate_pct: { label: "Lower band employee rate", type: "money", min: 0 },
    source_reference: { label: "Source / circular", required: true, max: 255 },
    notes: { label: "Notes", max: 500 },
  });
  if (!ok) return render(req, res, { form: values, errors }, 422);
  try {
    await addRule(req, values);
    req.flash("success_msg", "New rule added. Mark it verified once checked against the issuance; the previous rule now ends the day before.");
    res.redirect("/payroll/setup/statutory");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    await render(req, res, { form: values, errors: { form: e.message } }, e.status);
  }
});
