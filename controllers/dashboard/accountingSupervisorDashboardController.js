/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Accounting Supervisor dashboard: revenue, expenses, net profit, payroll expense, payables, receivables, cash flow,
// financial performance and every queue waiting for the supervisor's decision.
import { supervisorDashboard } from "../../services/dashboardService.js";
import { barChart, payrollCostChart } from "../../lib/chartConfig.js";

export const accountingSupervisorDashboard = async (req, res, base) => {
  const d = await supervisorDashboard(req.user);
  d.cfg = {
    performance: barChart("Revenue vs expenses", d.charts.months, [
      { name: "Revenue", slot: 1, data: d.charts.income },
      { name: "Expenses", slot: 2, data: d.charts.expense },
    ]),
    cashFlow: barChart("Net cash flow", d.charts.months, [{ name: "Net change in cash", slot: 3, data: d.charts.cashFlow }]),
    payroll: payrollCostChart(d.charts.payroll),
  };
  res.render("dashboard-supervisor", { ...base, d, panels: d.panels });
};
