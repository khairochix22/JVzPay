// Budgets (master prompt §IX): a monthly amount per expense or revenue account, compared with posted actuals.
import { select, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { toCents, fromCents } from "../lib/money.js";
import { badRequest } from "../lib/errors.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Budget vs actual for a year: one row per account that has a budget or activity, with monthly figures. */
export async function budgetVsActual(year) {
  const [accounts, budgets, actuals] = await Promise.all([
    select("SELECT id, code, name, account_type, normal_balance FROM chart_of_accounts WHERE account_type IN ('revenue','expense') AND is_active = 1 ORDER BY code"),
    select("SELECT account_id, month, amount FROM budgets WHERE fiscal_year = ?", [year]),
    select(
      `SELECT l.account_id, MONTH(j.entry_date) AS month, SUM(l.debit) AS d, SUM(l.credit) AS c
         FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id AND j.status IN ('posted','reversed')
        WHERE YEAR(j.entry_date) = ? GROUP BY l.account_id, MONTH(j.entry_date)`, [year]),
  ]);
  const rows = accounts.map((a) => {
    const sign = a.normal_balance === "credit" ? -1 : 1;
    const months = MONTHS.map((label, i) => {
      const b = budgets.find((x) => x.account_id === a.id && x.month === i + 1);
      const act = actuals.find((x) => x.account_id === a.id && Number(x.month) === i + 1);
      const actual = act ? sign * (toCents(act.d) - toCents(act.c)) : 0;
      return { label, month: i + 1, budget: b ? toCents(b.amount) : null, actual };
    });
    const budget = months.reduce((s, m) => s + (m.budget || 0), 0), actual = months.reduce((s, m) => s + m.actual, 0);
    // compare like with like: only the months that have a budget count against it
    const budgetedActual = months.filter((m) => m.budget !== null).reduce((s, m) => s + m.actual, 0);
    return {
      ...a, months: months.map((m) => ({ ...m, budget: m.budget === null ? "" : fromCents(m.budget), actual: fromCents(m.actual) })),
      budget: fromCents(budget), actual: fromCents(actual), budgetedActual: fromCents(budgetedActual),
      variance: fromCents(a.account_type === "expense" ? budget - budgetedActual : budgetedActual - budget),
      hasBudget: months.some((m) => m.budget !== null), over: a.account_type === "expense" ? budgetedActual > budget && budget > 0 : false,
      used: budget ? Math.round((budgetedActual / budget) * 100) : null,
    };
  }).filter((r) => r.hasBudget || toCents(r.actual) !== 0);
  return { rows, months: MONTHS };
}

/** Saves one account's twelve monthly amounts. Blank months are removed. */
export async function saveBudget(req, year, accountId, amounts) {
  if (!(year >= 2000 && year <= 2100)) throw badRequest("Choose a valid year.");
  const vals = MONTHS.map((_, i) => String(amounts?.[i] ?? amounts?.[String(i)] ?? "").replace(/[,\s₱]/g, ""));
  for (const v of vals) if (v !== "" && !/^\d+(\.\d{1,2})?$/.test(v)) throw badRequest("Budgets are amounts like 15000 or 15000.50.");
  await tx(async (trx) => {
    for (let m = 1; m <= 12; m++) {
      const v = vals[m - 1];
      if (v === "") await exec("DELETE FROM budgets WHERE fiscal_year = ? AND account_id = ? AND month = ?", [year, accountId, m], trx);
      else await exec("INSERT INTO budgets (fiscal_year, account_id, month, amount, updated_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE amount = VALUES(amount), updated_by = VALUES(updated_by)", [year, accountId, m, v, req.user.id], trx);
    }
    await audit(req, { action: "budget_saved", module: "accounting", recordType: "budget", recordId: `${year}:${accountId}`, next: { year, account_id: accountId, months: vals } }, trx);
  });
}
