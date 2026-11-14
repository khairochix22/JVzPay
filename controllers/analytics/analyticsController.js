// Data Analytics page (GET /analytics). Financial charts are shown only to roles that may see financial statements.
import { wrap } from "../../lib/errors.js";
import { analytics, filterOptions } from "../../services/analyticsService.js";
import { lineChart, barChart, doughnutChart, pieChart } from "../../lib/chartConfig.js";

export const page = wrap(async (req, res) => {
  const d = await analytics(req.query);
  const showFinance = req.user.can("reports.financial");
  const cfg = {
    trend: lineChart("Monthly payroll expense", d.months, [{ name: "Payroll cost", slot: 1, data: d.costs }]),
    grossNet: barChart("Gross pay vs net pay", d.months, [{ name: "Gross pay", slot: 1, data: d.gross }, { name: "Net pay", slot: 2, data: d.net }]),
    deductions: doughnutChart("Deduction analysis", d.deductions),
    overtime: barChart("Overtime expense", d.months, [{ name: "Overtime pay", slot: 1, data: d.ot }]),
    salary: barChart("Employee salary distribution", d.salaryDist.map((b) => b.name), [{ name: "Employees", slot: 1, data: d.salaryDist.map((b) => b.value) }], { format: "number", xLabel: "Monthly salary" }),
    weekday: barChart("Attendance patterns by weekday", d.weekday.map((x) => x.d), [{ name: "Late", slot: 2, data: d.weekday.map((x) => x.late) }, { name: "Absent", slot: 4, data: d.weekday.map((x) => x.absent) }], { format: "number", xLabel: "Weekday" }),
    byDept: barChart("Absence and lateness by department", d.byDept.map((x) => x.name), [{ name: "Late", slot: 2, data: d.byDept.map((x) => x.late) }, { name: "Absent", slot: 4, data: d.byDept.map((x) => x.absent) }], { format: "number", xLabel: "Department" }),
    opex: barChart("Monthly operating expenses", d.months, [{ name: "Operating expenses", slot: 1, data: d.opex }]),
    opexPie: pieChart("Operating expenses by account", d.opexByAccount, { xLabel: "Account" }),
    revExp: barChart("Revenue vs expenses", d.months, [{ name: "Revenue", slot: 1, data: d.revenue }, { name: "Expenses", slot: 2, data: d.expenses }]),
    netIncome: lineChart("Financial performance trend", d.months, [{ name: "Net income", slot: 1, data: d.netIncome }]),
    forecast: d.forecast ? lineChart("Payroll cost forecast", d.forecast.labels, [{ name: "Actual", slot: 1, data: d.forecast.actual }, { name: "Forecast (projection, not actual)", slot: 2, data: d.forecast.projected, dashed: true }]) : null,
  };
  const opts = await filterOptions();
  const qs = new URLSearchParams(Object.entries(d.f).filter(([, v]) => v)).toString();
  res.render("analytics", { title: "Data Analytics", d, cfg, ...opts, showFinance, qs });
});
