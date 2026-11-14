// Salary Loans page (GET /payroll/loans; POST /payroll/loans/:id/decision, POST /payroll/loans/:id/release):
// Accounting/Payroll Staff and the Accounting Supervisor approve or reject applications (never their own); Payroll Staff
// release approved loans, which payroll then deducts every payday until they are paid.
import { wrap, action } from "../../lib/errors.js";
import { queue, decide, release } from "../../services/salaryLoanService.js";

const back = (req) => `/payroll/loans${req.query.status ? `?status=${encodeURIComponent(req.query.status)}` : ""}`;

export const page = wrap(async (req, res) => {
  res.render("salary-loans", { title: "Salary Loans", ...(await queue(req.query.status || "open")),
    canApprove: req.user.can("loans.approve"), canRelease: req.user.can("loans.release") });
});

export const decision = action(async (req) => {
  const act = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : "";
  const l = await decide(req, Number(req.params.id), act, String(req.body.remarks || "").trim().slice(0, 500));
  return `${l.loan_no} ${act}.`;
}, back);

export const doRelease = action(async (req) => {
  await release(req, Number(req.params.id), req.body.reference);
  return "Loan released. Payroll will deduct it every payday.";
}, back);
