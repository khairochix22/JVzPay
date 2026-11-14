// User Accounts and Accounting Staff account requests (users.manage). URL map only; handlers live in controllers/users.
import express from "express";
import { requirePermission } from "../middleware/auth.js";
import * as userListController from "../controllers/users/userListController.js";
import * as userFormController from "../controllers/users/userFormController.js";
import * as accountRequestListController from "../controllers/users/accountRequestListController.js";
import * as accountRequestReviewController from "../controllers/users/accountRequestReviewController.js";

const r = express.Router();
r.use(requirePermission("users.manage"));

r.get("/", userListController.list);
r.get("/requests", accountRequestListController.queue);
r.get("/requests/:id(\\d+)", accountRequestReviewController.reviewPage);
r.post("/requests/:id(\\d+)/decision", accountRequestReviewController.decision);
r.get("/:id(\\d+)/edit", userFormController.editForm);
r.post("/:id(\\d+)", userFormController.update);
r.post("/:id(\\d+)/reset-password", userFormController.resetPassword);
r.post("/:id(\\d+)/reset-link", userFormController.resetLink);
r.post("/:id(\\d+)/unlock", userFormController.unlock);
r.post("/:id(\\d+)/revoke-sessions", userFormController.revokeSessions);

export default r;
