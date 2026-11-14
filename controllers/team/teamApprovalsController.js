// Team Approvals page (GET /team/approvals, POST /team/approvals/:kind/:id/decision): the immediate supervisor or team
// leader gives the FIRST approval of their team's leave, overtime, attendance corrections and vacation leave conversions.
// An approval sends the request to Accounting/Payroll for the final decision; a rejection ends it.
import { wrap, action, badRequest } from "../../lib/errors.js";
import { teamQueue, decideFirst, KINDS } from "../../services/supervisorApproval.js";

export const page = wrap(async (req, res) => {
  res.render("team-approvals", { title: "Team Approvals", rows: await teamQueue(req.user) });
});

export const decision = action(async (req) => {
  const kind = String(req.params.kind);
  if (!KINDS[kind]) throw badRequest("Unknown request type.");
  const act = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : "";
  const r = await decideFirst(req, kind, Number(req.params.id), act, String(req.body.remarks || "").trim().slice(0, 500));
  const no = r[KINDS[kind].no];
  return act === "approved" ? `${no} approved. It now goes to Accounting/Payroll for the final approval.` : `${no} rejected. The employee has been told.`;
}, "/team/approvals");
