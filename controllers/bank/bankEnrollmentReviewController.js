/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Bank enrollment review page (GET /bank-enrollments/:id): masked details, audited reveal (pending only), approve/reject.
import { wrap, HttpError } from "../../lib/errors.js";
import * as bank from "../../services/bankService.js";

const detail = async (req, res, extra = {}, status = 200) => {
  const q = await bank.getRequest(Number(req.params.id));
  const own = q.submitted_by === req.user.id || q.employee_id === req.user.employee_id;
  res.status(status).render("bank-review", { title: `Bank enrollment ${q.request_no}`, q, own, errors: {}, ...extra });
};

export const detailPage = wrap((req, res) => detail(req, res));

export const reveal = wrap(async (req, res) => {
  const full = await bank.revealNumber(req, Number(req.params.id));
  await detail(req, res, { revealed: full });
});

export const decision = wrap(async (req, res) => {
  const action = req.body.action === "approve" ? "approved" : req.body.action === "reject" ? "rejected" : null;
  const remarks = String(req.body.remarks || "").trim().slice(0, 500);
  try {
    const q = await bank.decide(req, Number(req.params.id), action, remarks);
    req.flash("success_msg", `${q.request_no} was ${action}. The employee has been notified.`);
    res.redirect("/bank-enrollments");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    if (e.status === 403) throw e;
    await detail(req, res, { errors: { decision: e.message }, remarks }, e.status);
  }
});
