// Transaction Categories page (GET/POST /accounting/categories): financial categories for income and expenses.
import { wrap, action, badRequest } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listCategories, addCategory, toggleCategory, activeAccounts } from "../../services/accountingService.js";

export const page = wrap(async (req, res) => {
  const accounts = (await activeAccounts()).filter((a) => ["revenue", "expense"].includes(a.account_type));
  res.render("transaction-categories", { title: "Transaction Categories", categories: await listCategories(), accounts, canManage: req.user.can("accounting.manage") });
});

export const add = action(async (req) => {
  const { values, errors, ok } = validate(req.body, {
    category_type: { label: "Type", type: "enum", values: ["income", "expense"], required: true },
    name: { label: "Name", required: true, max: 100 },
    default_account_id: { label: "Account", type: "id", required: true },
  });
  if (!ok) throw badRequest(Object.values(errors).join(" "));
  const c = await addCategory(req, values);
  return `Category ${c.name} added.`;
}, "/accounting/categories");

export const toggle = action(async (req) => {
  const c = await toggleCategory(req, Number(req.params.id));
  return `${c.name} is now ${c.is_active ? "active" : "inactive"}.`;
}, "/accounting/categories");
