// Attendance (staff/supervisor). URL map only; one controller per page in controllers/attendance.
import express from "express";
import { requirePermission, requireAny } from "../middleware/auth.js";
import * as attendanceRecordsController from "../controllers/attendance/attendanceRecordsController.js";
import * as attendanceEncodingController from "../controllers/attendance/attendanceEncodingController.js";
import * as attendanceValidationController from "../controllers/attendance/attendanceValidationController.js";
import * as correctionQueueController from "../controllers/attendance/correctionQueueController.js";
import * as correctionReviewController from "../controllers/attendance/correctionReviewController.js";
import * as workSchedulesController from "../controllers/attendance/workSchedulesController.js";

const r = express.Router();

r.get("/", requirePermission("attendance.view"), attendanceRecordsController.records);
r.get("/encode", requirePermission("attendance.encode"), attendanceEncodingController.encodeSheet);
r.post("/encode", requirePermission("attendance.encode"), attendanceEncodingController.saveEncoding);
r.get("/validation", requirePermission("attendance.validate"), attendanceValidationController.validationQueue);
r.post("/validation", requirePermission("attendance.validate"), attendanceValidationController.validateSelected);
r.get("/corrections", requireAny("attendance.correction.review", "attendance.view"), correctionQueueController.queue);
r.get("/corrections/:id(\\d+)", requireAny("attendance.correction.review", "attendance.view"), correctionReviewController.reviewPage);
r.post("/corrections/:id(\\d+)/decision", requirePermission("attendance.correction.review"), correctionReviewController.decision);
r.get("/schedules", requirePermission("schedules.manage"), workSchedulesController.page);

export default r;
