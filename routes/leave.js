// Leave administration (requests, calendar, types, balances). URL map only; one controller per page in controllers/leave.
import express from "express";
import { requirePermission, requireAny } from "../middleware/auth.js";
import * as leaveQueueController from "../controllers/leave/leaveQueueController.js";
import * as leaveReviewController from "../controllers/leave/leaveReviewController.js";
import * as leaveCalendarController from "../controllers/leave/leaveCalendarController.js";
import * as leaveTypesController from "../controllers/leave/leaveTypesController.js";
import * as leaveBalancesController from "../controllers/leave/leaveBalancesController.js";

const r = express.Router();

r.get("/leave-requests", requireAny("leave.view", "leave.review"), leaveQueueController.queue);
r.get("/leave-requests/:id(\\d+)", requireAny("leave.view", "leave.review"), leaveReviewController.reviewPage);
r.post("/leave-requests/:id(\\d+)/decision", requirePermission("leave.review"), leaveReviewController.decision);
r.get("/leave-calendar", requireAny("leave.view", "leave.review"), leaveCalendarController.calendarPage);
r.get("/leave-types", requirePermission("leave.config"), leaveTypesController.typesPage);
r.post("/leave-types", requirePermission("leave.config"), leaveTypesController.save);
r.post("/leave-types/:id(\\d+)", requirePermission("leave.config"), leaveTypesController.save);
r.get("/leave-balances", requireAny("leave.view", "leave.config"), leaveBalancesController.balances);
r.post("/leave-balances/adjust", requirePermission("leave.config"), leaveBalancesController.adjust);

export default r;
