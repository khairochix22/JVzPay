// Payroll. URL map only; one controller per page in controllers/payroll. Every workflow action has its own permission.
import express from "express";
import { requirePermission as can, requireAny as any } from "../middleware/auth.js";
import * as payroll from "../controllers/payroll/payrollController.js";
import * as batch from "../controllers/payroll/payrollBatchController.js";
import * as record from "../controllers/payroll/payrollRecordController.js";
import * as payItems from "../controllers/payroll/payItemsController.js";
import * as payItemReview from "../controllers/payroll/payItemReviewController.js";
import * as adjustments from "../controllers/payroll/payrollAdjustmentsController.js";
import * as adjustmentReview from "../controllers/payroll/payrollAdjustmentReviewController.js";
import * as enrollmentReview from "../controllers/payroll/enrollmentReviewController.js";
import * as payslipList from "../controllers/payroll/payslipListController.js";
import * as payslipView from "../controllers/payroll/payslipViewController.js";
import * as statutory from "../controllers/payroll/statutoryRulesController.js";
import * as tax from "../controllers/payroll/taxTableController.js";
import * as holidays from "../controllers/payroll/holidaysController.js";
import * as components from "../controllers/payroll/salaryComponentsController.js";
import * as salary from "../controllers/payroll/salaryVerificationController.js";
import * as leaveConversions from "../controllers/payroll/leaveConversionsController.js";
import * as retirement from "../controllers/payroll/retirementFundController.js";
import * as loans from "../controllers/payroll/salaryLoansController.js";

const r = express.Router();
const ID = ":id(\\d+)";

// one Payroll page for monitoring; periods are the supervisor's; each period has one run, computed automatically
r.get("/", any("payroll.view", "payroll.periods"), payroll.page);
r.get(["/periods", "/batches"], (req, res) => res.redirect(301, "/payroll"));
r.post("/periods/month", can("payroll.periods"), payroll.addMonth);
r.post("/periods/special", can("payroll.periods"), payroll.addSpecial);
r.post(`/periods/${ID}/compute`, can("payroll.prepare"), payroll.compute);
r.get(`/batches/${ID}`, can("payroll.view"), batch.show);
r.post(`/batches/${ID}/recompute`, can("payroll.prepare"), batch.recompute);
r.post(`/batches/${ID}/submit`, can("payroll.prepare"), batch.submit);
r.post(`/batches/${ID}/approve`, can("payroll.approve"), batch.approve);
r.post(`/batches/${ID}/reject`, can("payroll.approve"), batch.reject);
r.post(`/batches/${ID}/finalize`, can("payroll.finalize"), batch.finalize);
r.post(`/batches/${ID}/release`, can("payroll.finalize"), batch.release);
r.post(`/batches/${ID}/void`, can("payroll.finalize"), batch.voidBatch);
r.get(`/records/${ID}`, can("payroll.view"), record.show);

r.get("/pay-items", any("payitems.submit", "payitems.approve", "payroll.view"), payItems.page);
r.post("/pay-items", can("payitems.submit"), payItems.create);
r.post(`/pay-items/${ID}/end`, any("payitems.submit", "payitems.approve"), payItems.end);
r.get("/pay-items/review", can("payitems.approve"), payItemReview.queue);
r.post(`/pay-items/${ID}/decision`, can("payitems.approve"), payItemReview.decision);

r.get("/adjustments", any("payroll.adjust.submit", "payroll.adjust.approve", "payroll.view"), adjustments.page);
r.post("/adjustments", can("payroll.adjust.submit"), adjustments.create);
r.get("/adjustments/review", can("payroll.adjust.approve"), adjustmentReview.queue);
r.post(`/adjustments/${ID}/decision`, can("payroll.adjust.approve"), adjustmentReview.decision);

r.get("/enrollments", any("statutory.review", "benefits.review"), enrollmentReview.page);
r.post(`/enrollments/:kind(statutory|dependent|benefit)/${ID}/decision`, any("statutory.review", "benefits.review"), enrollmentReview.decision);
r.get("/payslips", can("payslips.view_all"), payslipList.list);
r.get(`/payslips/${ID}`, can("payslips.view_all"), payslipView.show);
r.get(`/payslips/${ID}/pdf`, can("payslips.view_all"), payslipView.pdf);

r.get("/salary-changes", can("employees.salary.verify"), salary.queue);
r.post(`/salary-changes/${ID}/decision`, can("employees.salary.verify"), salary.decision);

r.get("/setup/statutory", can("payroll.config"), statutory.page);
r.post("/setup/statutory", can("payroll.config"), statutory.add);
r.post(`/setup/statutory/${ID}/verify`, can("payroll.config"), statutory.verify);
r.get("/setup/tax", can("payroll.config"), tax.page);
r.post("/setup/tax", can("payroll.config"), tax.add);
r.post("/setup/tax/verify", can("payroll.config"), tax.verify);
r.get("/setup/holidays", can("payroll.config"), holidays.page);
r.post("/setup/holidays", can("payroll.config"), holidays.save);
r.post(`/setup/holidays/${ID}`, can("payroll.config"), holidays.save);
r.post(`/setup/holidays/${ID}/toggle`, can("payroll.config"), holidays.toggle);
r.get("/setup/components", can("payroll.config"), components.page);
r.post("/setup/components", can("payroll.config"), components.add);
r.post(`/setup/components/${ID}/toggle`, can("payroll.config"), components.toggle);

r.get("/leave-conversions", can("leave.conversion.review"), leaveConversions.page);
r.post(`/leave-conversions/${ID}/decision`, can("leave.conversion.review"), leaveConversions.decision);

r.get("/retirement", any("retirement.manage", "retirement.approve"), retirement.page);
r.post("/retirement/withdrawals", can("retirement.manage"), retirement.file);
r.post(`/retirement/withdrawals/${ID}/decision`, can("retirement.approve"), retirement.decision);
r.post(`/retirement/withdrawals/${ID}/paid`, can("retirement.manage"), retirement.paid);

r.get("/loans", any("loans.approve", "loans.release"), loans.page);
r.post(`/loans/${ID}/decision`, can("loans.approve"), loans.decision);
r.post(`/loans/${ID}/release`, can("loans.release"), loans.doRelease);

export default r;
