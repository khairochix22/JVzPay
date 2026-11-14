// Shared page logic for the Income and Expenses pages, which differ only in their transaction type.
import { wrap, action, HttpError } from "./errors.js";
import { validate } from "./validate.js";
import { listTransactions, listCategories, createTransaction, voidTransaction, PAYMENT_METHODS } from "../services/accountingService.js";

export function transactionPage({ type, title, path }) {
  async function render(req, res, extra = {}, status = 200) {
    res.status(status).render("transactions", {
      title, type, path, ...(await listTransactions(req, type)), categories: await listCategories(type), methods: PAYMENT_METHODS,
      canRecord: req.user.canAny("accounting.manage", "accounting.prepare"), canVoid: req.user.can("accounting.manage"),
      prepares: !req.user.can("accounting.manage"), form: { payment_method: "cash" }, errors: {}, ...extra,
    });
  }
  return {
    page: wrap((req, res) => render(req, res)),
    create: wrap(async (req, res) => {
      const { values, errors } = validate(req.body, {
        category_id: { label: "Category", type: "id", required: true },
        txn_date: { label: "Date", type: "date", required: true },
        amount: { label: "Amount", type: "money", required: true, min: 0.01 },
        payment_method: { label: "Payment method", type: "enum", values: PAYMENT_METHODS, required: true },
        description: { label: "Description", required: true, max: 255 },
        reference_no: { label: "Reference no.", max: 80 },
      });
      if (req.uploadError) errors.attachment = req.uploadError;
      if (Object.keys(errors).length) return render(req, res, { form: values, errors }, 422);
      try {
        const { no, posted } = await createTransaction(req, type, values, req.file);
        req.flash("success_msg", posted ? `${no} was recorded and posted to the journal.` : `${no} was sent to the Accounting Supervisor for approval.`);
        res.redirect(path);
      } catch (e) {
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
        await render(req, res, { form: values, errors: { form: e.message } }, e.status);
      }
    }),
    voidTxn: action(async (req) => {
      const t = await voidTransaction(req, Number(req.params.id), String(req.body.reason || "").trim().slice(0, 500));
      return `${t.txn_no} was voided and a reversing journal was posted.`;
    }, path),
  };
}
