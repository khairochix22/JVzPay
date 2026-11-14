// Financial Periods page (GET /accounting/periods): closing a month blocks any further posting into it.
import { wrap, action } from "../../lib/errors.js";
import { listFinancialPeriods, setFinancialPeriod } from "../../services/accountingService.js";

export const page = wrap(async (req, res) => {
  res.render("financial-periods", { title: "Financial Periods", periods: await listFinancialPeriods(), canManage: req.user.can("accounting.manage") });
});

export const close = action(async (req) => { const p = await setFinancialPeriod(req, Number(req.params.id), "closed"); return `${p.label} was closed.`; }, "/accounting/periods");
export const reopen = action(async (req) => { const p = await setFinancialPeriod(req, Number(req.params.id), "open"); return `${p.label} was reopened.`; }, "/accounting/periods");
