// Accounting Approvals page (GET /accounting/approvals, POST decision): entries prepared by staff and adjustments (accounting.adjust.approve).
import { wrap, action } from "../../lib/errors.js";
import { pendingApprovals, decideTransaction } from "../../services/accountingService.js";

export const queue = wrap(async (req, res) => {
  const rows = (await pendingApprovals()).map((r) => ({ ...r, own: r.created_by === req.user.id }));
  res.render("accounting-approvals", { title: "Accounting Approvals", rows });
});

export const decision = action(async (req) => {
  const act = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : null;
  const t = await decideTransaction(req, Number(req.params.id), act, String(req.body.remarks || "").trim().slice(0, 500));
  return `${t.txn_no} was ${act}.`;
}, "/accounting/approvals");
