
  /*
    MIT License

    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
    */

import express from "express";
import rateLimit from "express-rate-limit";
import * as privacyNotice from "../controllers/legal/privacyNoticeController.js";
import * as accountRequest from "../controllers/auth/accountRequestController.js";
import * as essRegistration from "../controllers/auth/essRegistrationController.js";
import * as essActivation from "../controllers/users/essActivationController.js";
import * as resetPassword from "../controllers/auth/resetPasswordController.js";
import * as sessionControl from "../controllers/auth/sessionController.js";
import * as privacyAck from "../controllers/legal/privacyAcknowledgeController.js";
import * as healthCheck from "../controllers/system/healthController.js";
import * as printLog from "../controllers/system/printLogController.js";
import { requireAuth, guestOnly, requirePermission } from "../middleware/auth.js";
import { loginPage, loginUser, logoutUser } from "../controllers/auth/loginController.js";
import { forgotPasswordPage } from "../controllers/auth/forgotPasswordController.js";
import { passwordPage, changePassword } from "../controllers/auth/changePasswordController.js";
import { dashboardPage } from "../controllers/dashboard/dashboardController.js";
import userRoutes from "./users.js";
import auditRoutes from "./audit.js";
import notificationRoutes from "./notifications.js";
import selfRoutes from "./self.js";
import bankReviewRoutes from "./bankReview.js";
import documentRoutes from "./documents.js";
import teamRoutes from "./team.js";
import attendanceRoutes from "./attendance.js";
import overtimeRoutes from "./overtime.js";
import leaveRoutes from "./leave.js";
import payrollRoutes from "./payroll.js";
import accountingRoutes from "./accounting.js";
import reportRoutes from "./reports.js";
import analyticsRoutes from "./analytics.js";
import settingsRoutes from "./settings.js";

const router = express.Router();

// "/" -> sign in or dashboard (the scaffold's public home page is not part of a private payroll system)
router.get("/", (req, res) => res.redirect(req.user ? "/dashboard" : "/login"));
router.get("/privacy", privacyNotice.page);
router.get("/healthz", healthCheck.health);

// ---- authentication (public) ----------------------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).render("login", { title: "Sign in", layoutBare: true, formError: "Too many sign-in attempts from this device. Please wait a few minutes and try again." }),
});
router.get("/login", guestOnly, loginPage);
router.post("/login", loginLimiter, guestOnly, loginUser);

// accounting staff ask for an account; an Accounting Supervisor approves (HR verification pending until HR is connected)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).render("register", { title: "Request an accounting staff account", layoutBare: true, form: {}, errors: { form: "Too many requests from this device. Please try again later." } }),
});
router.get("/register", guestOnly, accountRequest.page);
router.get("/register/sent", guestOnly, accountRequest.sentPage);
router.post("/register", registerLimiter, guestOnly, accountRequest.submit);
// employees create their Self-Service account, checked against HR (master prompt §IV)
router.get("/register/employee", guestOnly, essRegistration.page);
router.post("/register/employee", registerLimiter, guestOnly, essRegistration.submit);
router.get("/register/employee/done", guestOnly, essRegistration.donePage);
router.get("/forgot-password", guestOnly, forgotPasswordPage);
router.get("/reset-password/:token", resetPassword.page);
router.post("/reset-password/:token", loginLimiter, resetPassword.submit);
router.post("/logout", logoutUser);

// ---- everything below requires a signed-in user ---------------------------------------------------------------------------
router.get("/account/password", requireAuth, passwordPage);
router.post("/account/password", requireAuth, changePassword);
router.get("/privacy/acknowledge", requireAuth, privacyAck.page);
router.post("/privacy/acknowledge", requireAuth, privacyAck.submit);
router.post("/session/keepalive", requireAuth, sessionControl.keepAlive);
router.post("/activity/print", requireAuth, printLog.logPrinted);

router.get("/dashboard", requireAuth, dashboardPage);
// the log of employee registrations is for Payroll Staff too (ess.activate), so it sits outside the users.manage router
router.get("/users/registrations", requireAuth, requirePermission("ess.activate"), essActivation.page);
router.use("/users", requireAuth, userRoutes);
router.use("/audit", requireAuth, auditRoutes);
router.use("/notifications", requireAuth, notificationRoutes);
router.use("/my", requireAuth, selfRoutes);
router.use("/bank-enrollments", requireAuth, bankReviewRoutes);
router.use("/documents", requireAuth, documentRoutes);
router.use("/team", requireAuth, teamRoutes);
router.use("/attendance", requireAuth, attendanceRoutes);
router.use("/overtime", requireAuth, overtimeRoutes);
router.use("/payroll", requireAuth, payrollRoutes);
router.use("/accounting", requireAuth, accountingRoutes);
router.use("/reports", requireAuth, reportRoutes);
router.use("/analytics", requireAuth, analyticsRoutes);
router.use("/settings", requireAuth, settingsRoutes);
router.use(["/leave-requests", "/leave-calendar", "/leave-types", "/leave-balances"], requireAuth);
router.use("/", leaveRoutes); // full paths inside; authentication enforced by the line above

export default router;
