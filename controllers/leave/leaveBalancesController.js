/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Leave Balances page (GET /leave-balances, POST /leave-balances/adjust): credits per employee and audited adjustments.
import { wrap, HttpError } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { balancesPage, adjustBalance } from "../../services/leaveAdminService.js";
import { lookups } from "../../services/employeeService.js";

export const balances = wrap(async (req, res) => {
  const { departments } = await lookups();
  res.render("leave-balances", { title: "Leave Balances", ...(await balancesPage(req)), departments, canAdjust: req.user.can("leave.config") });
});

export const adjust = wrap(async (req, res) => {
  const { values, errors, ok } = validate(req.body, {
    employee_id: { label: "Employee", type: "id", required: true },
    leave_type_id: { label: "Leave type", type: "id", required: true },
    year: { label: "Year", type: "int", required: true, min: 2000, max: 2100 },
    delta: { label: "Adjustment", required: true, pattern: /^-?\d+(\.[05])?$/, patternMessage: "Enter whole or half days, e.g. 2, -1, 0.5." },
    reason: { label: "Reason", required: true, min: 5, max: 255 },
  });
  if (!ok) req.flash("error_msg", Object.values(errors).join(" "));
  else {
    try {
      await adjustBalance(req, values);
      req.flash("success_msg", "Leave balance adjusted. The employee has been notified.");
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      req.flash("error_msg", e.message);
    }
  }
  res.redirect(`/leave-balances?year=${values.year || ""}`);
});
