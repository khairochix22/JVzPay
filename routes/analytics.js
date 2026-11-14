// Data Analytics. URL map only; handler lives in controllers/analytics.
import express from "express";
import { requirePermission } from "../middleware/auth.js";
import * as analyticsController from "../controllers/analytics/analyticsController.js";

const r = express.Router();
r.get("/", requirePermission("analytics.view"), analyticsController.page);

export default r;
