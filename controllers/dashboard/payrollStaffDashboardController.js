/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Payroll Staff dashboard: current period, employees to process, attendance to validate, batches in preparation.
import { staffDashboard, dashboardPanels } from "../../services/dashboardService.js";
import { segmentsChart } from "../../lib/chartConfig.js";

export const payrollStaffDashboard = async (req, res, base) => {
  const d = await staffDashboard(req.user);
  d.cfg = { validation: segmentsChart("Attendance validation (last 31 days)", d.charts.validation) };
  res.render("dashboard-staff", { ...base, d, panels: await dashboardPanels(req.user) });
};
