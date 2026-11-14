// Payslip detail and PDF for authorised payroll personnel (GET /payroll/payslips/:id[/pdf]). Only finalized/released payroll has payslips.
import { wrap, HttpError } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { getPayslip, renderPayslipPdf } from "../../services/payslipService.js";

async function load(req) {
  const p = await getPayslip(Number(req.params.id));
  if (!p) throw new HttpError(404, "Payslip not found.");
  return p;
}

export const show = wrap(async (req, res) => {
  const p = await load(req);
  res.render("my-payslip", { title: `Payslip ${p.payslip_no}`, p, base: "/payroll/payslips", baseLabel: "Payslips" });
});

export const pdf = wrap(async (req, res) => {
  const p = await load(req);
  await audit(req, { action: "payslip_downloaded", module: "payslips", recordType: "payslip", recordId: p.id, remarks: `${p.employee_no} ${p.payslip_no}` });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Payslip-${p.payslip_no}.pdf"`);
  await renderPayslipPdf(p, res);
});
