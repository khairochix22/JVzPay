// Single source of truth for permissions and role grants. `npm run seed` writes this into the database;
// at runtime the database (role_permissions) is authoritative so the Accounting Supervisor can adjust grants.

// The four roles of the JOHNVIVZ Accounting & Payroll department (owner's decision, 2026-11-11):
// Accounting Supervisor → Accounting Staff and Payroll Staff; Employee Self-Service is the employees' own portal.
export const ROLES = [
  { code: "accounting_supervisor", name: "Accounting Supervisor", description: "Runs the department: approves financial transactions, payroll batches and requests, manages user accounts, settings and backups, and reviews the audit trail." },
  { code: "accounting_staff", name: "Accounting Staff", description: "Records revenue and expenses for approval, prepares journals and financial reports." },
  { code: "payroll_staff", name: "Payroll Staff", description: "Prepares attendance, computes payroll, manages payslips and submits batches for approval." },
  { code: "employee", name: "Employee", description: "Self-service access to own profile, payslips, attendance, leave and bank enrollment." },
];

// [code, module, description]
export const PERMISSIONS = [
  ["dashboard.view", "dashboard", "View the role dashboard"],

  ["users.manage", "users", "Create, edit, deactivate and reset user accounts"],
  ["roles.manage", "users", "View and adjust role permissions"],
  ["ess.activate", "users", "View employee account registrations"],

  ["employees.salary.verify", "employees", "Verify or reject salary changes"],

  ["payroll.config", "payroll", "Configure payroll policies, components, statutory rules and tax tables"],
  ["payroll.periods", "payroll", "Create payroll periods (semi-monthly on the fixed dates, or special periods for chosen departments or employees)"],
  ["payroll.view", "payroll", "View payroll batches and records"],
  ["payroll.prepare", "payroll", "Compute payroll and submit batches for approval"],
  ["payroll.approve", "payroll", "Approve or reject payroll batches"],
  ["payroll.finalize", "payroll", "Finalize, release and void payroll batches"],
  ["payroll.adjust.submit", "payroll", "Submit payroll adjustments"],
  ["payroll.adjust.approve", "payroll", "Approve or reject payroll adjustments"],
  ["payitems.submit", "payroll", "Encode allowances, loans and deductions"],
  ["payitems.approve", "payroll", "Approve or reject allowances, loans and deductions"],
  ["retirement.manage", "payroll", "View the retirement fund, file withdrawals for separated employees and record payouts"],
  ["retirement.approve", "payroll", "Approve or reject retirement fund withdrawals"],
  ["loans.approve", "payroll", "Approve or reject salary loan applications"],
  ["loans.release", "payroll", "Release approved salary loans"],

  ["attendance.view", "attendance", "View attendance records of all employees"],
  ["attendance.encode", "attendance", "Encode attendance manually"],
  ["attendance.validate", "attendance", "Validate attendance for payroll"],
  ["attendance.correction.review", "attendance", "Approve or reject attendance corrections"],
  ["overtime.submit", "attendance", "Encode overtime"],
  ["overtime.approve", "attendance", "Approve or reject overtime"],
  ["schedules.manage", "attendance", "View the schedules HR plotted for employees"],

  ["leave.view", "leave", "View leave applications and balances of all employees"],
  ["leave.review", "leave", "Approve or reject leave applications"],
  ["leave.config", "leave", "Configure leave types and entitlements"],
  ["leave.conversion.review", "leave", "Approve or reject vacation leave cash conversions"],

  ["bank.review", "bank", "Review, approve or reject bank enrollments (masked account data)"],

  ["payslips.view_all", "payslips", "View and generate payslips for all employees"],

  ["accounting.view", "accounting", "View chart of accounts, ledgers and journals"],
  ["accounting.manage", "accounting", "Record income, expenses and manage the chart of accounts"],
  ["accounting.prepare", "accounting", "Prepare accounting transactions for approval"],
  ["accounting.adjust.approve", "accounting", "Approve or reject accounting adjustments"],
  ["payables.prepare", "accounting", "Record supplier invoices and payments"],
  ["payables.approve", "accounting", "Approve or reject supplier invoices"],
  ["receivables.manage", "accounting", "Record customer receivables and collections"],
  ["bank.reconcile", "accounting", "Manage company bank accounts and reconcile them"],
  ["budgets.manage", "accounting", "Set budgets"],

  ["reports.view", "reports", "Generate payroll and HR reports"],
  ["reports.financial", "reports", "Generate financial statements"],
  ["analytics.view", "analytics", "View data analytics"],

  ["audit.view", "audit", "View the full audit trail"],
  ["audit.view_payroll", "audit", "View payroll-related audit history"],
  ["settings.manage", "settings", "Manage system settings, announcements and maintenance"],
  ["integration.manage", "integration", "Manage integration tokens and retry failed events"],

  // Self-service — only effective when the user account is linked to an employee record
  ["self.profile", "self", "View and update own profile"],
  ["self.payslips", "self", "View own released payslips"],
  ["self.attendance", "self", "View own attendance and request corrections"],
  ["self.leave", "self", "View own leave credits and apply for leave"],
  ["self.bank", "self", "Manage own bank enrollment"],
  ["self.enrollments", "self", "Submit own government enrollment, dependents and benefits"],
  ["self.overtime", "self", "Apply for own overtime"],
  ["self.retirement", "self", "Enroll in the retirement fund and request withdrawals"],
  ["self.loans", "self", "Apply for a salary loan and follow its repayment"],
  ["statutory.review", "self", "Verify employees' government enrollment numbers"],
  ["benefits.review", "self", "Verify dependents and benefit enrollments"],
];

const SELF = ["self.profile", "self.payslips", "self.attendance", "self.leave", "self.bank", "self.enrollments", "self.overtime", "self.retirement", "self.loans"];

// Accounting Staff and Payroll Staff approve or reject every request that comes from an employee (owner, 2026-11-13);
// nobody decides their own request or one they filed for someone else (each service checks that).
const EMPLOYEE_REQUESTS = [
  "leave.view", "leave.review", "attendance.view", "attendance.correction.review", "overtime.approve", "bank.review",
  "statutory.review", "benefits.review", "retirement.manage", "retirement.approve", "leave.conversion.review", "loans.approve",
];

export const ROLE_GRANTS = {
  // The supervisor approves and administers but never prepares payroll (payroll.prepare stays with Payroll Staff), and
  // no one can approve their own submission: every decision checks the requester against the approver.
  accounting_supervisor: [
    "dashboard.view", "users.manage", "roles.manage", "settings.manage",
    "employees.salary.verify",
    "payroll.config", "payroll.periods", "payroll.view", "payroll.approve", "payroll.finalize", "payroll.adjust.approve", "payitems.approve",
    "attendance.view", "attendance.correction.review", "overtime.approve", "schedules.manage",
    "leave.view", "leave.review", "leave.config", "leave.conversion.review", "retirement.manage", "retirement.approve", "loans.approve", "loans.release", "bank.review", "payslips.view_all",
    "accounting.view", "accounting.manage", "accounting.adjust.approve",
    "payables.prepare", "payables.approve", "receivables.manage", "bank.reconcile", "budgets.manage",
    "reports.view", "reports.financial", "analytics.view", "audit.view", "audit.view_payroll", "integration.manage", "ess.activate", "statutory.review", "benefits.review",
    ...SELF,
  ],
  // records revenue and expenses for the Accounting Supervisor to approve; no payroll or employee data
  accounting_staff: ["dashboard.view", "accounting.view", "accounting.prepare", "reports.financial", "payables.prepare", "receivables.manage", "bank.reconcile", ...EMPLOYEE_REQUESTS, ...SELF],
  payroll_staff: [
    "dashboard.view",
    "payroll.view", "payroll.prepare", "payroll.adjust.submit", "payitems.submit",
    "attendance.view", "attendance.encode", "attendance.validate", "overtime.submit", "schedules.manage", "loans.release", ...EMPLOYEE_REQUESTS,
    "leave.view", "payslips.view_all", "ess.activate", "statutory.review", "benefits.review",
    "reports.view", "analytics.view",
    ...SELF,
  ],
  employee: ["dashboard.view", ...SELF],
};

// a permission listed twice (in a role and in EMPLOYEE_REQUESTS) is granted once
for (const role of Object.keys(ROLE_GRANTS)) ROLE_GRANTS[role] = [...new Set(ROLE_GRANTS[role])];
