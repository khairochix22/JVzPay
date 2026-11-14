// Sidebar definition. An item is shown only when the user holds AT LEAST ONE of `perms` (server-side filtering;
// the same permission is enforced again on the route itself). Only implemented modules are listed.
// `needsEmployee` items need a user account linked to an employee record. `badge` names a pending-count key from locals.js.
export const NAV = [
  {
    group: "Overview", icon: "grid",
    items: [{ label: "Dashboard", href: "/dashboard", icon: "grid", perms: ["dashboard.view"] }],
  },
  {
    group: "Users", icon: "users",
    items: [
      { label: "User Accounts", href: "/users", icon: "key", perms: ["users.manage"] },
      { label: "Account Requests", href: "/users/requests", icon: "inbox", perms: ["users.manage"], badge: "accountRequests" },
      { label: "Employee Registrations", href: "/users/registrations", icon: "user-plus", perms: ["ess.activate"] },
    ],
  },
  {
    group: "Time & Leave", icon: "clock",
    items: [
      { label: "Attendance Records", href: "/attendance", icon: "clock", perms: ["attendance.view"] },
      { label: "Encode Attendance", href: "/attendance/encode", icon: "edit", perms: ["attendance.encode"] },
      { label: "Validate Attendance", href: "/attendance/validation", icon: "check-circle", perms: ["attendance.validate"], badge: "validation" },
      { label: "Overtime", href: "/overtime", icon: "trending-up", perms: ["overtime.submit", "attendance.view"] },
      { label: "Work Schedules", href: "/attendance/schedules", icon: "calendar", perms: ["schedules.manage"] },
      { label: "Leave Calendar", href: "/leave-calendar", icon: "calendar", perms: ["leave.view", "leave.review"] },
      { label: "Leave Balances", href: "/leave-balances", icon: "inbox", perms: ["leave.view", "leave.config"] },
      { label: "Leave Types", href: "/leave-types", icon: "file-text", perms: ["leave.config"] },
    ],
  },
  {
    group: "Payroll", icon: "wallet",
    items: [
      { label: "Payroll", href: "/payroll", icon: "wallet", perms: ["payroll.view", "payroll.periods"], badge: "payrollReview" },
      { label: "Allowances & Loans", href: "/payroll/pay-items", icon: "receipt", perms: ["payitems.submit", "payroll.view"] },
      { label: "Adjustments", href: "/payroll/adjustments", icon: "edit", perms: ["payroll.adjust.submit", "payroll.view"] },
      { label: "Payslips", href: "/payroll/payslips", icon: "file-text", perms: ["payslips.view_all"] },
      { label: "Retirement Fund", href: "/payroll/retirement", icon: "shield", perms: ["retirement.manage", "retirement.approve"], badge: "retirement" },
      { label: "Salary Loans", href: "/payroll/loans", icon: "wallet", perms: ["loans.approve", "loans.release"], badge: "loans" },
      { label: "Enrollment Verification", href: "/payroll/enrollments", icon: "shield", perms: ["statutory.review", "benefits.review"], badge: "enrollments" },
    ],
  },
  {
    group: "Payroll Setup", icon: "briefcase",
    items: [
      { label: "Statutory Rules", href: "/payroll/setup/statutory", icon: "shield", perms: ["payroll.config"] },
      { label: "Tax Table", href: "/payroll/setup/tax", icon: "file-text", perms: ["payroll.config"] },
      { label: "Holidays", href: "/payroll/setup/holidays", icon: "calendar", perms: ["payroll.config"] },
      { label: "Salary Components", href: "/payroll/setup/components", icon: "grid", perms: ["payroll.config"] },
    ],
  },
  {
    group: "Accounting", icon: "calculator",
    items: [
      { label: "Income", href: "/accounting/income", icon: "trending-up", perms: ["accounting.view", "accounting.prepare"] },
      { label: "Expenses", href: "/accounting/expenses", icon: "receipt", perms: ["accounting.view", "accounting.prepare"] },
      { label: "Adjustments", href: "/accounting/adjustments", icon: "edit", perms: ["accounting.manage", "accounting.prepare"] },
      { label: "Accounts Payable", href: "/accounting/payables", icon: "file-text", perms: ["payables.prepare", "payables.approve"], badge: "payables" },
      { label: "Accounts Receivable", href: "/accounting/receivables", icon: "inbox", perms: ["receivables.manage"] },
      { label: "Bank Reconciliation", href: "/accounting/banks", icon: "bank", perms: ["bank.reconcile"] },
      { label: "Budgets", href: "/accounting/budgets", icon: "calculator", perms: ["accounting.view"] },
      { label: "CRM Sales", href: "/accounting/sales", icon: "trending-up", perms: ["accounting.view"] },
      { label: "Journal Entries", href: "/accounting/journals", icon: "file-text", perms: ["accounting.view"] },
      { label: "Chart of Accounts", href: "/accounting/accounts", icon: "grid", perms: ["accounting.view"] },
      { label: "Categories", href: "/accounting/categories", icon: "inbox", perms: ["accounting.view"] },
      { label: "Financial Periods", href: "/accounting/periods", icon: "calendar", perms: ["accounting.view"] },
    ],
  },
  {
    group: "Insights", icon: "bar-chart",
    items: [
      { label: "Data Analytics", href: "/analytics", icon: "trending-up", perms: ["analytics.view"] },
      { label: "Reports", href: "/reports", icon: "file-text", perms: ["reports.view", "reports.financial"] },
    ],
  },
  {
    group: "Approvals", icon: "check-circle",
    items: [
      { label: "Team Approvals", href: "/team/approvals", icon: "users", perms: ["team.approve"], badge: "team" },
      { label: "Accounting Approvals", href: "/accounting/approvals", icon: "check-circle", perms: ["accounting.adjust.approve"], badge: "accountingAdj" },
      { label: "Salary Changes", href: "/payroll/salary-changes", icon: "wallet", perms: ["employees.salary.verify"], badge: "salaryChanges" },
      { label: "Pay Item Approvals", href: "/payroll/pay-items/review", icon: "receipt", perms: ["payitems.approve"], badge: "payItems" },
      { label: "Adjustment Approvals", href: "/payroll/adjustments/review", icon: "edit", perms: ["payroll.adjust.approve"], badge: "adjustments" },
      { label: "Leave Requests", href: "/leave-requests", icon: "calendar", perms: ["leave.review"], badge: "leave" },
      { label: "Attendance Corrections", href: "/attendance/corrections", icon: "clock", perms: ["attendance.correction.review"], badge: "corrections" },
      { label: "Overtime Approvals", href: "/overtime/review", icon: "trending-up", perms: ["overtime.approve"], badge: "overtime" },
      { label: "Bank Enrollments", href: "/bank-enrollments", icon: "bank", perms: ["bank.review"], badge: "bank" },
      { label: "VL Conversions", href: "/payroll/leave-conversions", icon: "wallet", perms: ["leave.conversion.review"], badge: "leaveConversions" },
    ],
  },
  {
    group: "My Workspace", icon: "user",
    items: [
      { label: "My Profile", href: "/my/profile", icon: "user", perms: ["self.profile"], needsEmployee: true },
      { label: "My Payslips", href: "/my/payslips", icon: "file-text", perms: ["self.payslips"], needsEmployee: true },
      { label: "Time Clock", href: "/my/clock", icon: "clock", perms: ["self.attendance"], needsEmployee: true },
      { label: "My Schedule", href: "/my/schedule", icon: "calendar", perms: ["self.attendance"], needsEmployee: true },
      { label: "My Attendance", href: "/my/attendance", icon: "check-circle", perms: ["self.attendance"], needsEmployee: true },
      { label: "My Leave", href: "/my/leave", icon: "calendar", perms: ["self.leave"], needsEmployee: true },
      { label: "My Bank Account", href: "/my/bank", icon: "bank", perms: ["self.bank"], needsEmployee: true },
      { label: "Government Enrollment", href: "/my/government", icon: "shield", perms: ["self.enrollments"], needsEmployee: true },
      { label: "Dependents & Benefits", href: "/my/benefits", icon: "users", perms: ["self.enrollments"], needsEmployee: true },
      { label: "My Overtime", href: "/my/overtime", icon: "trending-up", perms: ["self.overtime"], needsEmployee: true },
      { label: "Retirement Fund", href: "/my/retirement", icon: "wallet", perms: ["self.retirement"], needsEmployee: true },
      { label: "Salary Loan", href: "/my/loans", icon: "receipt", perms: ["self.loans"], needsEmployee: true },
      { label: "Holiday Calendar", href: "/my/holidays", icon: "calendar", perms: ["self.profile"], needsEmployee: true },
    ],
  },
  {
    group: "System", icon: "settings",
    items: [
      { label: "Notifications", href: "/notifications", icon: "bell", perms: ["dashboard.view"], badge: "unread" },
      { label: "Audit Logs", href: "/audit", icon: "shield", perms: ["audit.view", "audit.view_payroll"] },
      { label: "Security Monitor", href: "/settings/security", icon: "lock", perms: ["audit.view"] },
      { label: "Sign-in History", href: "/settings/security/sign-ins", icon: "clock", perms: ["audit.view"] },
      { label: "Announcements", href: "/settings/announcements", icon: "send", perms: ["settings.manage"] },
      { label: "System Settings", href: "/settings", icon: "grid", perms: ["settings.manage"] },
      { label: "Roles & Permissions", href: "/settings/roles", icon: "key", perms: ["roles.manage"] },
      { label: "Integration", href: "/settings/integration", icon: "send", perms: ["integration.manage"] },
      { label: "Backup & Maintenance", href: "/settings/backup", icon: "download", perms: ["settings.manage"] },
    ],
  },
];

const ALL_HREFS = NAV.flatMap((g) => g.items.map((i) => i.href));
const matches = (path, href) => path === href || path.startsWith(href + "/");

const countLabel = (n) => (n > 0 ? (n > 99 ? "99+" : n) : null);

// Each group comes back with: `single` (only one link visible, so it is drawn as a plain link), `open` (it holds the
// current page, so it starts expanded) and `count` (the sum of its pending badges, shown on the group while it is closed).
export function navFor(user, currentPath, unread = 0, counts = {}) {
  // the most specific matching link is the active one (/attendance/encode highlights "Encode", not "Records")
  const active = ALL_HREFS.filter((h) => matches(currentPath, h)).sort((a, b) => b.length - a.length)[0];
  return NAV.map((g) => {
    let total = 0;
    const items = g.items
      .filter((i) => i.perms.some((p) => user.permissions.has(p)) && (!i.needsEmployee || user.employee_id))
      .map((i) => {
        const n = i.badge === "unread" ? unread : i.badge ? counts[i.badge] || 0 : 0;
        total += n;
        return { ...i, active: i.href === active, count: countLabel(n) };
      });
    return { group: g.group, icon: g.icon, items, single: items.length === 1 ? items[0] : null, open: items.some((i) => i.active), count: countLabel(total) };
  }).filter((g) => g.items.length);
}
