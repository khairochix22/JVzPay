// Budgets page (GET /accounting/budgets): monthly budgets per revenue and expense account and how actuals compare.
import { wrap } from "../../lib/errors.js";
import { budgetVsActual, saveBudget } from "../../services/budgetService.js";
import { select } from "../../lib/db.js";

export const page = wrap(async (req, res) => {
  const year = Number(req.query.year) >= 2000 && Number(req.query.year) <= 2100 ? Number(req.query.year) : new Date().getFullYear();
  const data = await budgetVsActual(year);
  const accounts = await select("SELECT id, code, name FROM chart_of_accounts WHERE account_type IN ('revenue','expense') AND is_active = 1 ORDER BY code");
  const editId = Number(req.query.edit) || null;
  const editing = editId ? data.rows.find((r) => r.id === editId) || { ...accounts.find((a) => a.id === editId), months: data.months.map((label, i) => ({ label, month: i + 1, budget: "" })) } : null;
  res.render("budgets", { title: "Budgets", year, prev: year - 1, next: year + 1, ...data, accounts, editing, canEdit: req.user.can("budgets.manage") });
});

export const save = wrap(async (req, res) => {
  const year = Number(req.body.year), accountId = Number(req.body.account_id);
  // one field per month (month_1 … month_12), so a blank month can never shift the others
  await saveBudget(req, year, accountId, Array.from({ length: 12 }, (_, i) => req.body[`month_${i + 1}`] ?? ""));
  req.flash("success_msg", "Budget saved.");
  res.redirect(`/accounting/budgets?year=${year}`);
});
