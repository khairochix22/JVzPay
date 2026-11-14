// Notifications page. URL map only; handlers live in controllers/notifications.
import express from "express";
import * as notificationController from "../controllers/notifications/notificationController.js";

const r = express.Router();


r.get("/", notificationController.list);
r.post("/:id(\\d+)/read", notificationController.markRead);
r.post("/read-all", notificationController.markAllRead);

export default r;
