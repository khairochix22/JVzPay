// My Retirement Fund page (GET /my/retirement; POST enroll, withdraw, cancel): the employee chooses 10, 15 or 20 percent of
// the basic monthly salary, sees every payday's contribution with the company's matching share, and can request a withdrawal.
import { action, wrap, badRequest } from "../../lib/errors.js";
import { myFund, enroll as enrollIn, requestWithdrawal, cancelWithdrawal } from "../../services/retirementService.js";

export const page = wrap(async (req, res) => {
  res.render("my-retirement", { title: "Retirement Fund", ...(await myFund(req.user.employee_id)) });
});

export const enroll = action(async (req) => {
  const r = await enrollIn(req, req.user.employee_id, req.body.rate_percent);
  return r.changed ? `Your contribution is now ${r.rate}% starting with the next payroll.` : `You are enrolled at ${r.rate}%. Deductions start with the next payroll.`;
}, "/my/retirement");

export const withdraw = action(async (req) => {
  if (req.body.confirm !== "1") throw badRequest("Tick the box to confirm you understand what will be paid and what is forfeited.");
  const r = await requestWithdrawal(req, req.user.employee_id, String(req.body.reason || ""), String(req.body.remarks || "").trim().slice(0, 500));
  return `${r.no} was sent for approval: ₱${r.payable} payable${r.vested ? "" : `, ₱${r.forfeited} company share forfeited`}.`;
}, "/my/retirement");

export const cancel = action(async (req) => {
  await cancelWithdrawal(req, Number(req.params.id));
  return "Withdrawal request cancelled.";
}, "/my/retirement");
