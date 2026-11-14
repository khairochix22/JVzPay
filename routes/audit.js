// Audit Logs page. URL map only; handler lives in controllers/audit.
import express from "express";
import { requireAny } from "../middleware/auth.js";
import * as auditLogController from "../controllers/audit/auditLogController.js";

const r = express.Router();
r.use(requireAny("audit.view", "audit.view_payroll"));

r.get("/", auditLogController.auditLog);

export default r;
