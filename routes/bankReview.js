// Bank Enrollments review (bank.review). URL map only; handlers live in controllers/bank.
import express from "express";
import { requirePermission } from "../middleware/auth.js";
import * as bankEnrollmentQueueController from "../controllers/bank/bankEnrollmentQueueController.js";
import * as bankEnrollmentReviewController from "../controllers/bank/bankEnrollmentReviewController.js";

const r = express.Router();
r.use(requirePermission("bank.review"));

r.get("/", bankEnrollmentQueueController.queue);
r.get("/:id(\\d+)", bankEnrollmentReviewController.detailPage);
r.post("/:id(\\d+)/reveal", bankEnrollmentReviewController.reveal);
r.post("/:id(\\d+)/decision", bankEnrollmentReviewController.decision);

export default r;
