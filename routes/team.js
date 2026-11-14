// Team Approvals: the immediate supervisor's first approval of employee requests. URL map only; handlers in controllers/team.
// Only immediate supervisors / team leaders and Accounting Supervisors may open it (team.approve, set in middleware/auth.js);
// the service shows each of them only the requests they are the first approver of.
import express from "express";
import { requirePermission } from "../middleware/auth.js";
import * as teamApprovalsController from "../controllers/team/teamApprovalsController.js";

const r = express.Router();
r.use(requirePermission("team.approve"));
r.get("/approvals", teamApprovalsController.page);
r.post("/approvals/:kind(leave|overtime|attendance_correction|leave_conversion)/:id(\\d+)/decision", teamApprovalsController.decision);

export default r;
