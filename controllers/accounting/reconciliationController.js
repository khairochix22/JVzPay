// Bank Reconciliation page (GET/POST /accounting/reconciliations/:id): tick the journal lines the bank has cleared and close
// the reconciliation once the statement balance equals the cleared book balance.
import { wrap, HttpError } from "../../lib/errors.js";
import * as svc from "../../services/bankingService.js";

export const show = wrap(async (req, res) => {
  res.render("reconciliation", { title: "Bank Reconciliation", ...(await svc.getReconciliation(Number(req.params.id))) });
});

export const save = wrap(async (req, res) => {
  const id = Number(req.params.id);
  try {
    await svc.saveCleared(req, id, req.body.lines, req.body.finish === "1");
    req.flash("success_msg", req.body.finish === "1" ? "Reconciled: the statement agrees with the books." : "Cleared items saved.");
  } catch (e) {
    if (!(e instanceof HttpError && e.status < 500)) throw e;
    req.flash("error_msg", e.message);
  }
  res.redirect(`/accounting/reconciliations/${id}`);
});
