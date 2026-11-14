// Accounting Adjustment page (GET/POST /accounting/adjustments): a balanced manual journal that posts only after approval.
import { wrap, HttpError, badRequest } from "../../lib/errors.js";
import { isMoney } from "../../lib/money.js";
import { select } from "../../lib/db.js";
import { createAdjustment, activeAccounts } from "../../services/accountingService.js";

async function render(req, res, extra = {}, status = 200) {
  const recent = await select(
    `SELECT t.id, t.txn_no, t.txn_date, t.amount, t.description, t.status, t.decision_remarks, t.journal_entry_id, u.full_name AS created_by_name
       FROM accounting_transactions t JOIN users u ON u.id = t.created_by WHERE t.txn_type = 'adjustment' ORDER BY t.id DESC LIMIT 25`);
  res.status(status).render("accounting-adjustments", { title: "Accounting Adjustments", accounts: await activeAccounts(), recent, slots: ["l0", "l1", "l2", "l3", "l4", "l5"], form: {}, formError: null, ...extra });
}
export const page = wrap((req, res) => render(req, res));

export const create = wrap(async (req, res) => {
  const txn_date = String(req.body.txn_date || "");
  const description = String(req.body.description || "").trim().slice(0, 255);
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txn_date)) throw badRequest("Enter a valid date.");
    if (description.length < 5) throw badRequest("Describe the adjustment (at least 5 characters).");
    const lines = Object.entries(req.body.lines || {}).filter(([k, l]) => /^l\d$/.test(k) && l && l.account_id).map(([, l]) => {
      for (const v of [l.debit, l.credit]) if (v && !isMoney(v)) throw badRequest("Amounts must be plain numbers with up to 2 decimals.");
      return { account_id: l.account_id, debit: l.debit, credit: l.credit, description: String(l.description || "").slice(0, 255) };
    });
    const no = await createAdjustment(req, { txn_date, description, lines });
    req.flash("success_msg", `${no} was submitted for approval. It is not posted until a different authorised person approves it.`);
    res.redirect("/accounting/adjustments");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    await render(req, res, { form: req.body, formError: e.message }, e.status);
  }
});
