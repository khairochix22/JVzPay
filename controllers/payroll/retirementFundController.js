// Retirement Fund page (GET /payroll/retirement): members, balances and vesting; withdrawals to approve (Accounting
// Supervisor), withdrawals filed for resigned or terminated employees and payouts recorded (Payroll Staff).
import { wrap, action } from "../../lib/errors.js";
import { overview, requestWithdrawal, decideWithdrawal, markPaid } from "../../services/retirementService.js";

const back = "/payroll/retirement";

export const page = wrap(async (req, res) => {
  res.render("retirement-fund", { title: "Retirement Fund", ...(await overview()),
    canApprove: req.user.can("retirement.approve"), canManage: req.user.can("retirement.manage") });
});

export const file = action(async (req) => {
  const r = await requestWithdrawal(req, Number(req.body.employee_id), String(req.body.reason || ""), String(req.body.remarks || "").trim().slice(0, 500), { self: false });
  return `${r.no} was filed: ₱${r.payable} payable${r.vested ? "" : `, ₱${r.forfeited} forfeited`}.`;
}, back);

export const decision = action(async (req) => {
  const act = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : "";
  const w = await decideWithdrawal(req, Number(req.params.id), act, String(req.body.remarks || "").trim().slice(0, 500));
  return `${w.withdrawal_no} ${act}.`;
}, back);

export const paid = action(async (req) => {
  await markPaid(req, Number(req.params.id), req.body.reference);
  return "Payout recorded.";
}, back);
