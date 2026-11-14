/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Leave Types page (GET/POST /leave-types): entitlements, paid/unpaid, attachment rules, negative-balance policy (leave.config).
import { wrap, HttpError } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listLeaveTypes, saveLeaveType, leaveTypeSchema } from "../../services/leaveAdminService.js";

async function render(req, res, extra = {}, status = 200) {
  res.status(status).render("leave-types", { title: "Leave Types", types: await listLeaveTypes(), form: { is_paid: 1, is_active: 1 }, errors: {}, ...extra });
}
export const typesPage = wrap((req, res) => render(req, res));

export const save = wrap(async (req, res) => {
  const id = req.params.id ? Number(req.params.id) : null;
  const { values, errors, ok } = validate(req.body, leaveTypeSchema);
  if (values.requires_attachment && values.attachment_after_days === null) values.attachment_after_days = "0";
  if (!ok) {
    if (id) { req.flash("error_msg", Object.values(errors).join(" ")); return res.redirect("/leave-types"); }
    return render(req, res, { form: values, errors }, 422);
  }
  try {
    await saveLeaveType(req, id, values);
    req.flash("success_msg", id ? "Leave type updated." : "Leave type added. Employees receive its credits the next time their balances load.");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
    req.flash("error_msg", e.message);
  }
  res.redirect("/leave-types");
});
