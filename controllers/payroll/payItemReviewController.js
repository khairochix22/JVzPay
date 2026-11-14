// Pay Item Approvals page (GET /payroll/pay-items/review, POST decision) for the Accounting Supervisor.
import { wrap, action } from "../../lib/errors.js";
import { listPayItems, decidePayItem } from "../../services/payrollSetupService.js";

export const queue = wrap(async (req, res) => {
  res.render("pay-item-review", { title: "Pay Item Approvals", ...(await listPayItems(req, { defaultStatus: "pending" })) });
});

export const decision = action(async (req) => {
  const act = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : null;
  await decidePayItem(req, Number(req.params.id), act, String(req.body.remarks || "").trim().slice(0, 255));
  return `Pay item ${act}.`;
}, "/payroll/pay-items/review");
