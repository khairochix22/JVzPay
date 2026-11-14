/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Leave application review page (GET /leave-requests/:id, POST /leave-requests/:id/decision).
import { wrap, HttpError } from "../../lib/errors.js";
import { getApplication, decideLeave } from "../../services/leaveAdminService.js";

async function render(req, res, extra = {}, status = 200) {
  const a = await getApplication(Number(req.params.id));
  const own = a.submitted_by === req.user.id || a.employee_id === req.user.employee_id;
  res.status(status).render("leave-review", { title: `Leave ${a.application_no}`, a, own, canDecide: req.user.can("leave.review") && ["approved", "not_required"].includes(a.supervisor_status) && a.supervisor_decided_by !== req.user.id, viaHr: a.routed_to === "department", errors: {}, ...extra });
}
export const reviewPage = wrap((req, res) => render(req, res));

export const decision = wrap(async (req, res) => {
  const action = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : null;
  const remarks = String(req.body.remarks || "").trim().slice(0, 500);
  try {
    const a = await decideLeave(req, Number(req.params.id), action, remarks);
    req.flash("success_msg", `${a.application_no} was ${action}. The employee has been notified.`);
    res.redirect("/leave-requests");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500 || e.status === 403) throw e;
    await render(req, res, { errors: { decision: e.message }, remarks }, e.status);
  }
});
