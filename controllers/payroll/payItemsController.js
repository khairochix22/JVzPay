// Allowances, Loans & Deductions page (GET/POST /payroll/pay-items): recurring items per employee (payitems.submit).
import { wrap, action, HttpError } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listPayItems, createPayItem, endPayItem, payItemComponents } from "../../services/payrollSetupService.js";
import { activeEmployees } from "../../services/overtimeService.js";

async function render(req, res, extra = {}, status = 200) {
  const canSubmit = req.user.can("payitems.submit");
  res.status(status).render("pay-items", {
    title: "Allowances, Loans & Deductions", ...(await listPayItems(req)), canSubmit, canEnd: req.user.canAny("payitems.submit", "payitems.approve"),
    employees: canSubmit ? await activeEmployees() : [], components: await payItemComponents(), form: {}, errors: {}, ...extra,
  });
}
export const page = wrap((req, res) => render(req, res));

export const create = wrap(async (req, res) => {
  const { values, errors, ok } = validate(req.body, {
    employee_id: { label: "Employee", type: "id", required: true },
    component_id: { label: "Component", type: "id", required: true },
    description: { label: "Description", max: 200 },
    amount: { label: "Amount per period", type: "money", required: true, min: 0.01 },
    remaining_balance: { label: "Total to recover", type: "money", min: 0.01 },
    effective_from: { label: "Effective from", type: "date", required: true },
    effective_to: { label: "Effective to", type: "date" },
  });
  if (!ok) return render(req, res, { form: values, errors }, 422);
  try {
    await createPayItem(req, values);
    req.flash("success_msg", "Pay item submitted for supervisor approval. It applies to payroll only once approved.");
    res.redirect("/payroll/pay-items");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    await render(req, res, { form: values, errors: { form: e.message } }, e.status);
  }
});

export const end = action(async (req) => { await endPayItem(req, Number(req.params.id)); return "Pay item ended."; }, "/payroll/pay-items");
