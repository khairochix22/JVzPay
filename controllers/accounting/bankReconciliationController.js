// Bank Accounts page (GET /accounting/banks): the company's bank accounts with book balances, adding one, and starting a
// statement reconciliation (which continues on the Bank Reconciliation page).
import { wrap, HttpError } from "../../lib/errors.js";
import * as svc from "../../services/bankingService.js";

async function render(req, res, extra = {}, status = 200) {
  const [banks, unused, recs] = await Promise.all([svc.listBankAccounts(), svc.unusedCashAccounts(), svc.listReconciliations()]);
  res.status(status).render("banks", { title: "Bank Accounts & Reconciliation", banks, unused, recs, form: {}, errors: {}, today: new Date().toISOString().slice(0, 10), ...extra });
}

export const page = wrap((req, res) => render(req, res));

export const addBank = wrap(async (req, res) => {
  const r = await svc.addBankAccount(req, req.body);
  if (r.errors) return render(req, res, { form: r.values, errors: r.errors }, 422);
  req.flash("success_msg", "Bank account added.");
  res.redirect("/accounting/banks");
});

export const start = wrap(async (req, res) => {
  try {
    const id = await svc.startReconciliation(req, Number(req.params.id), req.body);
    res.redirect(`/accounting/reconciliations/${id}`);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) { req.flash("error_msg", e.message); return res.redirect("/accounting/banks"); }
    throw e;
  }
});
