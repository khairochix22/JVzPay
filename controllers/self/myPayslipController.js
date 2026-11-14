/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Single payslip page (GET /my/payslips/:id) and its PDF download — own RELEASED payslips only.
import { audit } from "../../lib/audit.js";
import { wrap, HttpError } from "../../lib/errors.js";
import { getPayslip, renderPayslipPdf } from "../../services/payslipService.js";

export const payslipPage = wrap(async (req, res) => {
  const p = await getPayslip(Number(req.params.id), { employeeId: req.user.employee_id });
  if (!p) throw new HttpError(404, "Payslip not found.");
  res.render("my-payslip", { title: `Payslip ${p.payslip_no}`, p });
});

export const payslipPdf = wrap(async (req, res) => {
  const p = await getPayslip(Number(req.params.id), { employeeId: req.user.employee_id });
  if (!p) throw new HttpError(404, "Payslip not found.");
  await audit(req, { action: "payslip_downloaded", module: "payslips", recordType: "payslip", recordId: p.id });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Payslip-${p.payslip_no}.pdf"`);
  await renderPayslipPdf(p, res);
});
