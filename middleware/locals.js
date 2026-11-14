import { teamCount } from "../services/supervisorApproval.js";
import { navFor } from "../config/nav.js";
import { REPORTS } from "../services/reportDefinitions.js";
import { env } from "../config/env.js";
import { scalar } from "../lib/db.js";

// Exposes per-request view data: the signed-in user (with permission list), filtered navigation, unread count, flash.
export async function viewLocals(req, res, next) {
  try {
    res.locals.company = env.company;
    res.locals.currentPath = req.path;
    res.locals.year = new Date().getFullYear();
    res.locals.sessionIdleMs = env.sessionIdleMinutes * 60 * 1000;
    if (req.user) {
      const unread = await scalar("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0", [req.user.id]);
      res.locals.me = {
        id: req.user.id,
        name: req.user.full_name,
        email: req.user.email,
        role: req.user.role_code,
        roleName: req.user.role_name,
        employeeId: req.user.employee_id,
        permissions: [...req.user.permissions],
      };
      res.locals.unread = Number(unread) || 0;
      // pending-work badges in the sidebar, only for queues this user can act on
      const P = req.user.permissions;
      const counts = {};
      const count = async (sql) => Number(await scalar(sql)) || 0;
      if (P.has("statutory.review") || P.has("benefits.review")) counts.enrollments = await count("SELECT (SELECT COUNT(*) FROM statutory_enrollments WHERE status = 'pending') + (SELECT COUNT(*) FROM dependent_enrollments WHERE status = 'pending') + (SELECT COUNT(*) FROM benefit_enrollment_references WHERE status = 'pending')");
      if (P.has("payables.approve")) counts.payables = await count("SELECT COUNT(*) FROM supplier_invoices WHERE status = 'pending_approval'");
      if (P.has("users.manage")) counts.accountRequests = await count("SELECT COUNT(*) FROM account_requests WHERE status = 'pending'");
      if (P.has("bank.review")) counts.bank = await count("SELECT COUNT(*) FROM bank_enrollment_requests WHERE status = 'pending'");
      if (P.has("leave.review")) counts.leave = await count("SELECT COUNT(*) FROM leave_applications WHERE status = 'pending' AND supervisor_status IN ('approved','not_required')");
      if (P.has("attendance.correction.review")) counts.corrections = await count("SELECT COUNT(*) FROM attendance_correction_requests WHERE status = 'pending' AND supervisor_status IN ('approved','not_required')");
      if (P.has("overtime.approve")) counts.overtime = await count("SELECT COUNT(*) FROM overtime_records WHERE status = 'pending' AND supervisor_status IN ('approved','not_required')");
      if (P.has("attendance.validate")) counts.validation = await count("SELECT COUNT(*) FROM attendance_records WHERE validation_status = 'pending'");
      if (P.has("payroll.approve")) counts.payrollReview = await count("SELECT COUNT(*) FROM payroll_batches WHERE status = 'for_review'");
      if (P.has("payroll.adjust.approve")) counts.adjustments = await count("SELECT COUNT(*) FROM payroll_adjustments WHERE status = 'pending'");
      if (P.has("employees.salary.verify")) counts.salaryChanges = await count("SELECT COUNT(*) FROM salary_history WHERE verification_status = 'pending'");
      if (P.has("payitems.approve")) counts.payItems = await count("SELECT COUNT(*) FROM employee_pay_items WHERE status = 'pending'");
      if (P.has("leave.conversion.review")) counts.leaveConversions = await count("SELECT COUNT(*) FROM leave_conversions WHERE status = 'pending' AND supervisor_status IN ('approved','not_required')");
      // first approvals waiting for this user as an immediate supervisor (or as an Accounting Supervisor)
      if (P.has("team.approve")) counts.team = await teamCount(req.user);
      if (P.has("retirement.approve")) counts.retirement = await count("SELECT COUNT(*) FROM retirement_withdrawals WHERE status = 'pending'");
      else if (P.has("retirement.manage")) counts.retirement = await count("SELECT COUNT(*) FROM retirement_withdrawals WHERE status = 'approved'");
      if (P.has("loans.approve")) counts.loans = await count("SELECT COUNT(*) FROM salary_loans WHERE status = 'pending'");
      else if (P.has("loans.release")) counts.loans = await count("SELECT COUNT(*) FROM salary_loans WHERE status = 'approved'");
      if (P.has("accounting.adjust.approve")) counts.accountingAdj = await count("SELECT COUNT(*) FROM accounting_transactions WHERE status = 'pending_approval'");
      res.locals.nav = navFor(req.user, req.originalUrl.split("?")[0], res.locals.unread, counts);
      // the top-bar search finds sidebar pages plus every report this user may open
      res.locals.searchReports = Object.values(REPORTS)
        .filter((d) => req.user.canAny(...d.perms))
        .map((d) => ({ title: d.title, group: d.group, href: `/reports/${d.key}` }));
    }
    next();
  } catch (e) {
    next(e);
  }
}
