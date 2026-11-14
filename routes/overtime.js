// Overtime. URL map only; one controller per page in controllers/overtime.
import express from "express";
import { requirePermission, requireAny } from "../middleware/auth.js";
import * as overtimeController from "../controllers/overtime/overtimeController.js";
import * as overtimeReviewController from "../controllers/overtime/overtimeReviewController.js";

const r = express.Router();

r.get("/", requireAny("overtime.submit", "overtime.approve", "attendance.view"), overtimeController.overtimePage);
r.post("/", requirePermission("overtime.submit"), overtimeController.encode);
r.get("/review", requirePermission("overtime.approve"), overtimeReviewController.reviewQueue);
r.post("/:id(\\d+)/decision", requirePermission("overtime.approve"), overtimeReviewController.decision);

export default r;
