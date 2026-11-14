// Accounting Staff dashboard: this month's books, the person's own entries and what is waiting on them.
import { accountingStaffDashboard as load } from "../../services/dashboardService.js";
import { barChart } from "../../lib/chartConfig.js";

export const accountingStaffDashboard = async (req, res, base) => {
  const d = await load(req.user);
  d.cfg = {
    incomeExpense: barChart("Revenue vs expenses", d.charts.months, [
      { name: "Revenue", slot: 1, data: d.charts.income },
      { name: "Expenses", slot: 2, data: d.charts.expense },
    ]),
  };
  res.render("dashboard-accounting", { ...base, d });
};
