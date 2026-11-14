// Accounts Payable page (GET /accounting/payables): suppliers, supplier invoices (record → approve → pay), aging totals.
import { wrap, HttpError } from "../../lib/errors.js";
import { activeAccounts } from "../../services/accountingService.js";
import * as svc from "../../services/payablesService.js";

async function render(req, res, extra = {}, status = 200) {
  const [list, suppliers, accounts, cash] = await Promise.all([svc.listInvoices(req), svc.listSuppliers(), svc.purchaseAccounts(), svc.cashAccounts()]);
  res.status(status).render("payables", {
    title: "Accounts Payable", ...list, suppliers, activeSuppliers: suppliers.filter((s) => s.is_active), accounts, cash, methods: svc.PAY_METHODS,
    canApprove: req.user.can("payables.approve"), form: {}, errors: {}, supForm: {}, supErrors: {}, today: new Date().toISOString().slice(0, 10), ...extra,
  });
}
const userError = (e) => e instanceof HttpError && e.status < 500;
const back = (req) => `/accounting/payables${req.query.status ? `?status=${encodeURIComponent(req.query.status)}` : ""}`;

export const page = wrap((req, res) => render(req, res));

export const addSupplier = wrap(async (req, res) => {
  const r = await svc.saveSupplier(req, req.body);
  if (r.errors) return render(req, res, { supForm: r.values, supErrors: r.errors }, 422);
  req.flash("success_msg", "Supplier added.");
  res.redirect("/accounting/payables");
});

export const createInvoice = wrap(async (req, res) => {
  const { values, errors } = svc.checkInvoice(req.body);
  if (req.uploadError) errors.attachment = req.uploadError;
  if (Object.keys(errors).length) return render(req, res, { form: values, errors }, 422);
  try {
    const r = await svc.createInvoice(req, values, req.file);
    req.flash("success_msg", `${r.no} recorded and sent to the Accounting Supervisor for approval.${r.match.status === "unmatched" ? ` It does not match Inventory yet: ${r.match.note}` : ""}`);
    res.redirect("/accounting/payables");
  } catch (e) { if (userError(e)) return render(req, res, { form: values, errors: { form: e.message } }, e.status); throw e; }
});

export const decide = wrap(async (req, res) => {
  await svc.decideInvoice(req, Number(req.params.id), req.body.action, req.body.remarks);
  req.flash("success_msg", req.body.action === "approve" ? "Approved and posted to Accounts Payable." : "Rejected; the preparer was told why.");
  res.redirect(back(req));
});

export const pay = wrap(async (req, res) => {
  const { values, errors } = svc.checkPayment(req.body);
  if (Object.keys(errors).length) { req.flash("error_msg", Object.values(errors)[0]); return res.redirect(back(req)); }
  const no = await svc.payInvoice(req, Number(req.params.id), values);
  req.flash("success_msg", `Payment ${no} posted.`);
  res.redirect(back(req));
});

export const voidInvoice = wrap(async (req, res) => {
  await svc.voidInvoice(req, Number(req.params.id), req.body.reason);
  req.flash("success_msg", "Invoice voided; its journal entry was reversed.");
  res.redirect(back(req));
});
