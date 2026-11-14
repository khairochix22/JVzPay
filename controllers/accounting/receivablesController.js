// Accounts Receivable page (GET /accounting/receivables): customers, receivables (incl. CRM sales on account), collections, aging.
import { wrap, HttpError } from "../../lib/errors.js";
import * as svc from "../../services/receivablesService.js";
import { cashAccounts, checkPayment, PAY_METHODS } from "../../services/payablesService.js";
import { tx } from "../../lib/db.js";

async function render(req, res, extra = {}, status = 200) {
  const [list, customers, revenue, cash] = await Promise.all([svc.listReceivables(req), svc.listCustomers(), svc.revenueAccounts(), cashAccounts()]);
  res.status(status).render("receivables", {
    title: "Accounts Receivable", ...list, customers, activeCustomers: customers.filter((c) => c.is_active), revenue, cash, methods: PAY_METHODS,
    form: {}, errors: {}, custForm: {}, custErrors: {}, today: new Date().toISOString().slice(0, 10), ...extra,
  });
}
const back = (req) => `/accounting/receivables${req.query.status ? `?status=${encodeURIComponent(req.query.status)}` : ""}`;

export const page = wrap((req, res) => render(req, res));

export const addCustomer = wrap(async (req, res) => {
  const r = await svc.saveCustomer(req, req.body);
  if (r.errors) return render(req, res, { custForm: r.values, custErrors: r.errors }, 422);
  req.flash("success_msg", "Customer added.");
  res.redirect("/accounting/receivables");
});

export const create = wrap(async (req, res) => {
  const { values, errors } = svc.checkReceivable(req.body);
  if (Object.keys(errors).length) return render(req, res, { form: values, errors }, 422);
  try {
    const r = await tx((trx) => svc.createReceivable(req, values, trx));
    req.flash("success_msg", `${r.no} recorded and posted.`);
    res.redirect("/accounting/receivables");
  } catch (e) { if (e instanceof HttpError && e.status < 500) return render(req, res, { form: values, errors: { form: e.message } }, e.status); throw e; }
});

export const collect = wrap(async (req, res) => {
  const { values, errors } = checkPayment(req.body);
  if (Object.keys(errors).length) { req.flash("error_msg", Object.values(errors)[0]); return res.redirect(back(req)); }
  const no = await svc.collect(req, Number(req.params.id), values);
  req.flash("success_msg", `Collection ${no} posted.`);
  res.redirect(back(req));
});

export const voidReceivable = wrap(async (req, res) => {
  await svc.voidReceivable(req, Number(req.params.id), req.body.reason);
  req.flash("success_msg", "Receivable voided; its journal entry was reversed.");
  res.redirect(back(req));
});
