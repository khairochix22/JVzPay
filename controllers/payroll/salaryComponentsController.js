// Salary Components page (GET/POST /payroll/setup/components): earning and deduction types (payroll.config).
import { wrap, action, badRequest } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listComponents, addComponent, toggleComponent, COMPONENT_CATEGORIES } from "../../services/payrollSetupService.js";

export const page = wrap(async (req, res) => {
  res.render("salary-components", { title: "Salary Components", components: await listComponents(), categories: [...COMPONENT_CATEGORIES.earning, ...COMPONENT_CATEGORIES.deduction] });
});

export const add = action(async (req) => {
  const { values, errors, ok } = validate(req.body, {
    code: { label: "Code", required: true, max: 40, pattern: /^[A-Za-z0-9_]+$/, patternMessage: "Code may contain letters, digits and underscores." },
    name: { label: "Name", required: true, max: 120 },
    category: { label: "Category", type: "enum", values: [...COMPONENT_CATEGORIES.earning, ...COMPONENT_CATEGORIES.deduction], required: true },
    is_taxable: { type: "bool" },
  });
  if (!ok) throw badRequest(Object.values(errors).join(" "));
  const c = await addComponent(req, values);
  return `${c.name} was added.`;
}, "/payroll/setup/components");

export const toggle = action(async (req) => {
  const c = await toggleComponent(req, Number(req.params.id));
  return `${c.name} is now ${c.is_active ? "active" : "inactive"}.`;
}, "/payroll/setup/components");
