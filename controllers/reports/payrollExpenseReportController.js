// Payroll Expense Report page and its PDF/Excel export (GET /reports/<key>[/export]).
import { reportPages } from "../../lib/reportController.js";
import { REPORTS } from "../../services/reportDefinitions.js";

export const { page, exportFile } = reportPages(REPORTS.payrollExpense);
