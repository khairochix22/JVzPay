// Withholding Tax Table page (GET/POST /payroll/setup/tax): effective-dated graduated annual table (payroll.config).
import { wrap, action, badRequest } from "../../lib/errors.js";
import { isMoney } from "../../lib/money.js";
import { listTaxTables, verifyTaxTable, addTaxTable } from "../../services/payrollSetupService.js";

export const page = wrap(async (req, res) => {
  res.render("tax-table", { title: "Withholding Tax Table", tables: await listTaxTables(), blankRows: [0, 1, 2, 3, 4, 5, 6, 7] });
});

export const verify = action(async (req) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.effective_from || "")) throw badRequest("Invalid effective date.");
  await verifyTaxTable(req, req.body.effective_from);
  return "Tax table marked as verified.";
}, "/payroll/setup/tax");

export const add = action(async (req) => {
  const eff = String(req.body.effective_from || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) throw badRequest("Enter a valid effective date.");
  const source = String(req.body.source_reference || "").trim().slice(0, 255);
  if (!source) throw badRequest("Enter the source (law or BIR issuance) of this table.");
  // keys are prefixed ("r0") because the query-string parser compacts numeric keys into arrays
  const rows = Object.entries(req.body.rows || {}).filter(([k, r]) => /^r\d+$/.test(k) && r && String(r.annual_from ?? "").trim() !== "")
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([, r]) => {
      const to = String(r.annual_to ?? "").trim();
      for (const v of [r.annual_from, r.base_tax || "0", r.rate_pct || "0", ...(to ? [to] : [])]) if (!isMoney(v)) throw badRequest("Bracket amounts must be plain numbers with up to 2 decimals.");
      return { annual_from: String(r.annual_from).replace(/,/g, ""), annual_to: to ? to.replace(/,/g, "") : null, base_tax: String(r.base_tax || "0").replace(/,/g, ""), rate_pct: r.rate_pct || "0" };
    });
  await addTaxTable(req, eff, source, rows);
  return "New tax table added. Mark it verified once checked against the BIR issuance.";
}, "/payroll/setup/tax");
