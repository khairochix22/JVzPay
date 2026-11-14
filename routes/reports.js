// Reports. URL map only; one controller per report in controllers/reports. Access comes from each report's own permission list.
import express from "express";
import { requireAny } from "../middleware/auth.js";
import { REPORTS } from "../services/reportDefinitions.js";
import * as catalog from "../controllers/reports/reportCatalogController.js";
import * as employeeMasterlist from "../controllers/reports/employeeMasterlistReportController.js";
import * as payrollRegister from "../controllers/reports/payrollRegisterReportController.js";
import * as monthlyPayroll from "../controllers/reports/monthlyPayrollReportController.js";
import * as payrollExpense from "../controllers/reports/payrollExpenseReportController.js";
import * as employeeCompensation from "../controllers/reports/employeeCompensationReportController.js";
import * as deductionSummary from "../controllers/reports/deductionSummaryReportController.js";
import * as attendanceSummary from "../controllers/reports/attendanceSummaryReportController.js";
import * as dailyTimeRecords from "../controllers/reports/dailyTimeRecordsReportController.js";
import * as overtimeSummary from "../controllers/reports/overtimeSummaryReportController.js";
import * as leaveSummary from "../controllers/reports/leaveSummaryReportController.js";
import * as bankEnrollmentSummary from "../controllers/reports/bankEnrollmentSummaryReportController.js";
import * as expenseReport from "../controllers/reports/expenseReportController.js";
import * as incomeReport from "../controllers/reports/incomeReportController.js";
import * as incomeStatement from "../controllers/reports/incomeStatementReportController.js";
import * as balanceSheet from "../controllers/reports/balanceSheetReportController.js";
import * as cashFlow from "../controllers/reports/cashFlowReportController.js";
import * as trialBalance from "../controllers/reports/trialBalanceReportController.js";
import * as generalLedger from "../controllers/reports/generalLedgerReportController.js";
import * as financialAnalytics from "../controllers/reports/financialAnalyticsReportController.js";

const r = express.Router();
r.get("/", requireAny("reports.view", "reports.financial"), catalog.catalog);

const add = (def, c) => {
  r.get(`/${def.key}`, requireAny(...def.perms), c.page);
  r.get(`/${def.key}/export`, requireAny(...def.perms), c.exportFile);
};
add(REPORTS.employeeMasterlist, employeeMasterlist);
add(REPORTS.payrollRegister, payrollRegister);
add(REPORTS.monthlyPayroll, monthlyPayroll);
add(REPORTS.payrollExpense, payrollExpense);
add(REPORTS.employeeCompensation, employeeCompensation);
add(REPORTS.deductionSummary, deductionSummary);
add(REPORTS.attendanceSummary, attendanceSummary);
add(REPORTS.dailyTimeRecords, dailyTimeRecords);
add(REPORTS.overtimeSummary, overtimeSummary);
add(REPORTS.leaveSummary, leaveSummary);
add(REPORTS.bankEnrollmentSummary, bankEnrollmentSummary);
add(REPORTS.expenseReport, expenseReport);
add(REPORTS.incomeReport, incomeReport);
add(REPORTS.incomeStatement, incomeStatement);
add(REPORTS.balanceSheet, balanceSheet);
add(REPORTS.cashFlow, cashFlow);
add(REPORTS.trialBalance, trialBalance);
add(REPORTS.generalLedger, generalLedger);
add(REPORTS.financialAnalytics, financialAnalytics);

export default r;
