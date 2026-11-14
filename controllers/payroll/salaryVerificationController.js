// Salary Change Verification page (GET /payroll/salary-changes, POST decision) for the Accounting Supervisor.
// A batch cannot be submitted while a salary change for one of its employees is unverified.
import { wrap, action } from "../../lib/errors.js";
import { listSalaryChanges, decideSalaryChange } from "../../services/payrollSetupService.js";

export const queue = wrap(async (req, res) => {
  res.render("salary-changes", { title: "Salary Change Verification", ...(await listSalaryChanges(req)) });
});

export const decision = action(async (req) => {
  const act = req.body.action === "approve" ? "verified" : req.body.action === "reject" ? "rejected" : null;
  await decideSalaryChange(req, Number(req.params.id), act, String(req.body.remarks || "").trim().slice(0, 255));
  return act === "verified" ? "Salary change verified." : "Salary change rejected; the previous rate was restored.";
}, "/payroll/salary-changes");
