/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// My Payslips page (GET /my/payslips): released payslips only.
import { wrap } from "../../lib/errors.js";
import { myPayslips } from "../../services/payslipService.js";

export const listPayslips = wrap(async (req, res) => {
  res.render("my-payslips", { title: "My Payslips", rows: await myPayslips(req.user.employee_id) });
});
