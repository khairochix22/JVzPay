// My Salary Loan page (GET /my/loans; POST /my/loans, POST /my/loans/:id/cancel): eligibility, how much the employee may
// borrow, a quote for the amount and term chosen, the application, and each loan's repayment progress.
import { wrap, action, HttpError } from "../../lib/errors.js";
import { myLoans, checkApplication, apply as applyLoan, cancel as cancelLoan, loanQuote } from "../../services/salaryLoanService.js";

async function render(req, res, extra = {}, status = 200) {
  const data = await myLoans(req.user.employee_id);
  const form = extra.form || { term_months: data.policy.terms[data.policy.terms.length - 1] };
  // the figures for what is in the form, so the employee sees the payday deduction before applying
  const quote = data.basic && form.principal && /^\d+(\.\d{1,2})?$/.test(String(form.principal))
    ? loanQuote({ principal: form.principal, termMonths: Number(form.term_months), monthlyBasic: data.basic.monthly, payFrequency: data.basic.payFrequency }, data.policy) : null;
  res.status(status).render("my-loans", { title: "Salary Loan", ...data, form, quote, errors: {}, interestPct: Math.round(data.policy.interestRate * 10000) / 100, ...extra });
}

export const page = wrap((req, res) => render(req, res, req.query.principal ? { form: { principal: String(req.query.principal).replace(/,/g, ""), term_months: Number(req.query.term_months) } } : {}));

export const apply = wrap(async (req, res) => {
  const { values, errors } = checkApplication(req.body);
  if (Object.keys(errors).length) return render(req, res, { form: values, errors }, 422);
  try {
    const r = await applyLoan(req, values);
    req.flash("success_msg", `${r.no}: ₱${r.principal} for ${values.term_months} months was sent for approval. ₱${r.amortization} will be deducted every payday once it is released.`);
    res.redirect("/my/loans");
  } catch (e) {
    if (e instanceof HttpError && e.status < 500 && e.status !== 403) return render(req, res, { form: values, errors: { form: e.message } }, e.status);
    throw e;
  }
});

export const cancel = action(async (req) => {
  await cancelLoan(req, Number(req.params.id));
  return "Loan application cancelled.";
}, "/my/loans");
