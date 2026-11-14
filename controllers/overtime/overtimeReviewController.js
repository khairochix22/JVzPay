/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Overtime Approvals page (GET /overtime/review, POST /overtime/:id/decision) for the Accounting Supervisor (overtime.approve).
import { wrap, HttpError } from "../../lib/errors.js";
import { listOvertime, decideOvertime } from "../../services/overtimeService.js";

export const reviewQueue = wrap(async (req, res) => {
  res.render("overtime-review", { title: "Overtime Approvals", ...(await listOvertime(req, { defaultStatus: "pending" })) });
});

export const decision = wrap(async (req, res) => {
  const action = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : null;
  try {
    await decideOvertime(req, Number(req.params.id), action, String(req.body.remarks || "").trim().slice(0, 255));
    req.flash("success_msg", `Overtime ${action}. The employee has been notified.`);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    req.flash("error_msg", e.message);
  }
  res.redirect("/overtime/review");
});
