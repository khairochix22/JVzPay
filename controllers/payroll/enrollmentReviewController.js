// Enrollment Verification page (GET /payroll/enrollments, POST /payroll/enrollments/:kind/:id/decision):
// Payroll Staff verify employees' government numbers, dependents and benefit enrollments.
import { wrap } from "../../lib/errors.js";
import { reviewQueue, decide } from "../../services/enrollmentService.js";

export const page = wrap(async (req, res) => {
  res.render("enrollment-review", { title: "Enrollment Verification", ...(await reviewQueue(req.user)) });
});

export const decision = wrap(async (req, res) => {
  const kind = ["statutory", "dependent", "benefit"].includes(req.params.kind) ? req.params.kind : null;
  await decide(req, kind, Number(req.params.id), req.body.action, req.body.remarks);
  req.flash("success_msg", req.body.action === "approve" ? "Verified." : "Rejected; the employee was told why.");
  res.redirect("/payroll/enrollments");
});
