/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Attendance correction review page (GET /attendance/corrections/:id): original vs requested values, approve/reject.
import { wrap, HttpError } from "../../lib/errors.js";
import { getCorrection, decideCorrection } from "../../services/attendanceService.js";

async function render(req, res, extra = {}, status = 200) {
  const q = await getCorrection(Number(req.params.id));
  const own = q.submitted_by === req.user.id || q.employee_id === req.user.employee_id;
  res.status(status).render("correction-review", {
    title: `Correction ${q.request_no}`, q, own, canDecide: req.user.can("attendance.correction.review") && ["approved", "not_required"].includes(q.supervisor_status) && q.supervisor_decided_by !== req.user.id, viaHr: q.routed_to === "department", errors: {}, ...extra,
  });
}
export const reviewPage = wrap((req, res) => render(req, res));

export const decision = wrap(async (req, res) => {
  const action = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : null;
  const remarks = String(req.body.remarks || "").trim().slice(0, 500);
  try {
    const r = await decideCorrection(req, Number(req.params.id), action, remarks);
    req.flash("success_msg", `${r.request_no} was ${action}. The employee has been notified.`);
    res.redirect("/attendance/corrections");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500 || e.status === 403) throw e;
    await render(req, res, { errors: { decision: e.message }, remarks }, e.status);
  }
});
