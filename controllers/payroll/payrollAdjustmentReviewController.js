// Payroll Adjustment Approvals page (GET /payroll/adjustments/review, POST decision) for the Accounting Supervisor.
import { wrap, action } from "../../lib/errors.js";
import { listAdjustments, decideAdjustment } from "../../services/payrollSetupService.js";

export const queue = wrap(async (req, res) => {
  res.render("payroll-adjustment-review", { title: "Adjustment Approvals", ...(await listAdjustments(req, { defaultStatus: "pending" })) });
});

export const decision = action(async (req) => {
  const act = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : null;
  const a = await decideAdjustment(req, Number(req.params.id), act, String(req.body.remarks || "").trim().slice(0, 500));
  return `${a.adjustment_no} was ${act}.`;
}, "/payroll/adjustments/review");
