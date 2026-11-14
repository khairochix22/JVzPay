// GET /api/v1/hr/* — read API for the HR system (the host). HR service token only. docs/API_INTEGRATION.md §5.2
import { jsonApi } from "../../middleware/apiClient.js";
import * as q from "../../services/integrationQueryService.js";

export const employees = jsonApi((req) => q.hrEmployees(req.query));
export const employee = jsonApi((req) => q.hrEmployee(req.params.employeeId));
export const leaveBalances = jsonApi((req) => q.hrLeaveBalances(req.params.employeeId, req.query));
export const payslips = jsonApi((req) => q.hrEmployeePayslips(req.params.employeeId, req.query));
export const attendance = jsonApi((req) => q.hrAttendance(req.query));
export const leaveRequests = jsonApi((req) => q.hrLeaveRequests(req.query));
export const overtime = jsonApi((req) => q.hrOvertime(req.query));
export const pendingApprovals = jsonApi((req) => q.hrPendingFirstApprovals(req.query));
export const payrollPeriods = jsonApi((req) => q.hrPayrollPeriods(req.query));
export const payrollPeriodSummary = jsonApi((req) => {
  const id = parseInt(req.params.periodId, 10);
  return q.hrPayrollPeriodSummary(Number.isFinite(id) ? id : 0);
});
