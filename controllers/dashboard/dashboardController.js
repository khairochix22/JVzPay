/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// GET /dashboard — sends each role to its own dashboard controller.
import { accountingSupervisorDashboard } from "./accountingSupervisorDashboardController.js";
import { accountingStaffDashboard } from "./accountingStaffDashboardController.js";
import { payrollStaffDashboard } from "./payrollStaffDashboardController.js";
import { employeeSelfDashboard } from "./employeeDashboardController.js";

// the four department roles, each with its own dashboard (master prompt §XIII)
const BY_ROLE = {
  accounting_supervisor: accountingSupervisorDashboard,
  accounting_staff: accountingStaffDashboard,
  payroll_staff: payrollStaffDashboard,
  employee: employeeSelfDashboard,
};

export const dashboardPage = async (req, res, next) => {
  try {
    const render = BY_ROLE[req.user.role_code];
    if (!render) return res.status(403).render("error", { title: "No dashboard", code: 403, message: "Your role has no dashboard assigned." });
    const base = { title: "Dashboard", welcomeName: (req.user.first_name || req.user.full_name || "").split(" ")[0], generatedAt: new Date() };
    await render(req, res, base);
  } catch (e) {
    next(e);
  }
};
