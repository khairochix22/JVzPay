/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Employee self-service dashboard: latest pay, bank account, pending requests, attendance, leave credits, notifications.
import { employeeDashboard } from "../../services/dashboardService.js";
import { segmentsChart } from "../../lib/chartConfig.js";

export const employeeSelfDashboard = async (req, res, base) => {
  const d = await employeeDashboard(req.user);
  if (!d.unlinked) d.cfg = { attendance: segmentsChart("My attendance this month", d.attendance) };
  res.render("dashboard-employee", { ...base, d, today: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }) });
};
