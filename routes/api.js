// Service-to-service API for the other JOHNVIVZ applications. URL map only; mounted before sessions and CSRF in index.js.
import express from "express";
import rateLimit from "express-rate-limit";
import * as events from "../controllers/integration/eventsApiController.js";
import * as hr from "../controllers/integration/hrApiController.js";
import * as crm from "../controllers/integration/crmApiController.js";
import * as inv from "../controllers/integration/inventoryApiController.js";
import { requireClient } from "../middleware/apiClient.js";
import "../services/salesPurchasingHandlers.js"; // registers the CRM and Inventory event handlers
import "../services/requestRoutingHandlers.js"; // registers RequestDecided (department supervisors deciding through HR)
import "../services/scheduleHandlers.js"; // registers ScheduleDaysPlotted (HR plots each employee's days)

const r = express.Router();
// generous enough for a payroll-day burst of HR events, low enough to stop a runaway sender
r.use(rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: "draft-7", legacyHeaders: false, message: { status: "rate_limited", error: "Too many requests; retry in a minute." } }));
r.get("/health", events.health);
r.post("/events", events.receive);
// stricter: these are password checks
r.post("/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false, message: { authenticated: false, error: "Too many sign-in attempts; try again later." } }), events.departmentLogin);

// read API (GET) — each group answers only its own application's token; docs/API_INTEGRATION.md §5
const HR = requireClient("johnvivz_hr"), CRM = requireClient("johnvivz_crm"), INV = requireClient("johnvivz_inventory");
r.get("/events/:eventId", requireClient(), events.eventStatus);
r.get("/feed", requireClient(), events.feed);

r.get("/hr/employees", HR, hr.employees);
r.get("/hr/employees/:employeeId", HR, hr.employee);
r.get("/hr/employees/:employeeId/leave-balances", HR, hr.leaveBalances);
r.get("/hr/employees/:employeeId/payslips", HR, hr.payslips);
r.get("/hr/attendance", HR, hr.attendance);
r.get("/hr/leave-requests", HR, hr.leaveRequests);
r.get("/hr/overtime", HR, hr.overtime);
r.get("/hr/pending-approvals", HR, hr.pendingApprovals);
r.get("/hr/payroll/periods", HR, hr.payrollPeriods);
r.get("/hr/payroll/periods/:periodId", HR, hr.payrollPeriodSummary);

r.get("/crm/sales/:transactionId", CRM, crm.sale);
r.get("/crm/receivables", CRM, crm.receivables);
r.get("/crm/customers/:customerRef/balance", CRM, crm.customerBalance);

r.get("/inventory/purchase-orders/:purchaseOrderId", INV, inv.purchaseOrder);
r.get("/inventory/supplier-invoices", INV, inv.supplierInvoices);
r.get("/inventory/suppliers/:supplierRef/balance", INV, inv.supplierBalance);

r.use((req, res) => res.status(404).json({ status: "not_found", error: `No API route ${req.method} ${req.path}` }));

export default r;
