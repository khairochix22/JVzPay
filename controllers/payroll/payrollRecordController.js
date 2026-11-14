// Payroll record page (GET /payroll/records/:id): one employee's computation breakdown and notes.
import { wrap } from "../../lib/errors.js";
import { getRecord } from "../../services/payrollService.js";

export const show = wrap(async (req, res) => {
  const r = await getRecord(Number(req.params.id));
  res.render("payroll-record", { title: `${r.employee_name} — ${r.batch_no}`, r });
});
