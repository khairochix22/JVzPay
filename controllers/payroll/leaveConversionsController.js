// VL Conversions page (GET /payroll/leave-conversions, POST /payroll/leave-conversions/:id/decision): the Accounting
// Supervisor approves or rejects year-end cash conversions of unused vacation leave; approved ones are paid by payroll.
import { wrap, action } from "../../lib/errors.js";
import { listConversions, decideConversion } from "../../services/leaveConversionService.js";

export const page = wrap(async (req, res) => {
  res.render("leave-conversions", { title: "Vacation Leave Conversions", ...(await listConversions(req.query.status || "pending")) });
});

export const decision = action(async (req) => {
  const act = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : "";
  const c = await decideConversion(req, Number(req.params.id), act, String(req.body.remarks || "").trim().slice(0, 500));
  return `${c.conversion_no} ${act}.`;
}, "/payroll/leave-conversions");
