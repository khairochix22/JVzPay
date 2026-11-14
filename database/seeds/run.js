// Base seed: CONFIGURATION ONLY (roles, permissions, chart of accounts, components, leave types, settings,
// statutory reference defaults, first Accounting Supervisor). Idempotent — safe to re-run; it never overwrites edited settings.
import bcrypt from "bcrypt";
import { env } from "../../config/env.js";
import { ROLES, PERMISSIONS, ROLE_GRANTS } from "../../config/permissions.js";
import { exec, selectOne, sequelize } from "../../lib/db.js";
import { checkPassword } from "../../lib/validate.js";

const log = (m) => console.log(m);

// ---------------------------------------------------------------- roles & permissions
for (const r of ROLES) {
  await exec("INSERT INTO roles (code, name, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)", [r.code, r.name, r.description]);
}
for (const [code, module, description] of PERMISSIONS) {
  await exec("INSERT INTO permissions (code, module, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE module = VALUES(module), description = VALUES(description)", [code, module, description]);
}
for (const [roleCode, perms] of Object.entries(ROLE_GRANTS)) {
  const role = await selectOne("SELECT id FROM roles WHERE code = ?", [roleCode]);
  for (const p of perms) {
    const perm = await selectOne("SELECT id FROM permissions WHERE code = ?", [p]);
    if (!perm) throw new Error(`Unknown permission "${p}" granted to ${roleCode}`);
    await exec("INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)", [role.id, perm.id]);
  }
}
log(`✅ roles (${ROLES.length}) and permissions (${PERMISSIONS.length}) seeded`);

// ---------------------------------------------------------------- chart of accounts
// [code, name, type, normal, parentCode, isCash, isSystem]
const COA = [
  ["1010", "Cash on Hand", "asset", "debit", null, 1, 1],
  ["1020", "Cash in Bank", "asset", "debit", null, 1, 1],
  ["1100", "Accounts Receivable", "asset", "debit", null, 0, 0],
  ["2010", "Accounts Payable", "liability", "credit", null, 0, 0],
  ["2100", "Payroll Payable", "liability", "credit", null, 0, 1],
  ["2200", "Employee Benefits Payable", "liability", "credit", null, 0, 1],
  ["2210", "SSS Payable", "liability", "credit", "2200", 0, 1],
  ["2220", "PhilHealth Payable", "liability", "credit", "2200", 0, 1],
  ["2230", "Pag-IBIG Payable", "liability", "credit", "2200", 0, 1],
  ["2240", "Withholding Tax Payable", "liability", "credit", "2200", 0, 1],
  ["3010", "Owner's Capital", "equity", "credit", null, 0, 0],
  ["3020", "Retained Earnings", "equity", "credit", null, 0, 1],
  ["4010", "Sales Revenue", "revenue", "credit", null, 0, 0],
  ["4020", "Other Income", "revenue", "credit", null, 0, 0],
  ["5010", "Salary Expense", "expense", "debit", null, 0, 1],
  ["5020", "Overtime Expense", "expense", "debit", null, 0, 1],
  ["5030", "Employee Benefits Expense", "expense", "debit", null, 0, 1],
  ["5040", "Cost of Goods Sold (Merchandise Purchases)", "expense", "debit", null, 0, 0],
  ["5110", "Rent Expense", "expense", "debit", null, 0, 0],
  ["5120", "Utilities Expense", "expense", "debit", null, 0, 0],
  ["5130", "Supplies Expense", "expense", "debit", null, 0, 0],
  ["5190", "Other Operating Expenses", "expense", "debit", null, 0, 0],
];
for (const [code, name, type, normal, parent, isCash, isSystem] of COA) {
  const p = parent ? await selectOne("SELECT id FROM chart_of_accounts WHERE code = ?", [parent]) : null;
  await exec(
    `INSERT INTO chart_of_accounts (code, name, account_type, normal_balance, parent_id, is_cash, is_system)
     VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [code, name, type, normal, p?.id ?? null, isCash, isSystem]
  );
}
const CATEGORIES = [
  ["income", "Sales Revenue", "4010"], ["income", "Other Income", "4020"],
  ["expense", "Merchandise Purchases (COGS)", "5040"], ["expense", "Rent", "5110"], ["expense", "Utilities", "5120"],
  ["expense", "Supplies", "5130"], ["expense", "Other Operating Expenses", "5190"],
];
for (const [type, name, acct] of CATEGORIES) {
  const a = await selectOne("SELECT id FROM chart_of_accounts WHERE code = ?", [acct]);
  await exec("INSERT IGNORE INTO transaction_categories (category_type, name, default_account_id) VALUES (?,?,?)", [type, name, a.id]);
}
log("✅ chart of accounts and transaction categories seeded");

// ---------------------------------------------------------------- salary components
const COMPONENTS = [
  ["BASIC", "Basic Pay", "earning", "basic", 1], ["OT", "Overtime Pay", "earning", "overtime", 1],
  ["HOLIDAY", "Holiday Pay", "earning", "holiday", 1], ["NIGHTDIFF", "Night Differential", "earning", "night_diff", 1],
  ["ALLOWANCE", "Allowance", "earning", "allowance", 1], ["INCENTIVE", "Incentive", "earning", "incentive", 1],
  ["BONUS", "Bonus", "earning", "bonus", 1], ["OTHER_EARN", "Other Approved Earnings", "earning", "other_earning", 1],
  ["SSS", "SSS Contribution", "deduction", "statutory", 0], ["PHILHEALTH", "PhilHealth Contribution", "deduction", "statutory", 0],
  ["PAGIBIG", "Pag-IBIG Contribution", "deduction", "statutory", 0], ["WTAX", "Withholding Tax", "deduction", "tax", 0],
  ["ABSENCE", "Absence / Late / Undertime", "deduction", "absence", 0], ["LOAN", "Loan / Salary Advance", "deduction", "loan", 0],
  ["OTHER_DED", "Other Authorized Deduction", "deduction", "other_deduction", 0],
  ["RETIREMENT", "Retirement Fund Contribution", "deduction", "retirement", 0], ["LEAVE_CONV", "Vacation Leave Conversion", "earning", "other_earning", 0],
];
for (const [code, name, type, cat, taxable] of COMPONENTS) {
  await exec("INSERT IGNORE INTO salary_components (code, name, component_type, category, is_taxable, is_system) VALUES (?,?,?,?,?,1)", [code, name, type, cat, taxable]);
}

// ---------------------------------------------------------------- leave types (company policy DEFAULTS — management must confirm)
const LEAVE = [
  ["VL", "Vacation Leave", 10, 1, 0, null, 0], ["SL", "Sick Leave", 5, 1, 1, 2, 0],
  ["EL", "Emergency Leave", 3, 1, 0, null, 0], ["LWOP", "Leave Without Pay", 0, 0, 0, null, 1],
];
for (const [code, name, days, paid, reqAtt, attAfter, neg] of LEAVE) {
  await exec(
    `INSERT IGNORE INTO leave_types (code, name, annual_entitlement_days, is_paid, requires_attachment, attachment_after_days, allow_negative_balance)
     VALUES (?,?,?,?,?,?,?)`,
    [code, name, days, paid, reqAtt, reqAtt ? attAfter : null, neg]
  );
}
await exec("UPDATE leave_types SET convertible_to_cash = 1 WHERE code = 'VL'");

// ---------------------------------------------------------------- system settings (INSERT IGNORE: never overwrites edits)
const SETTINGS = [
  // [key, value, type, group, description]
  ["attendance.work_start", "08:00", "time", "attendance", "Standard shift start"],
  ["attendance.work_end", "17:00", "time", "attendance", "Standard shift end"],
  ["attendance.break_minutes", "60", "number", "attendance", "Unpaid break per day (minutes)"],
  ["attendance.grace_minutes", "10", "number", "attendance", "Minutes of lateness before it is counted"],
  ["attendance.hours_per_day", "8", "number", "attendance", "Standard paid hours per day"],
  ["attendance.rest_day", "0", "number", "attendance", "Default day off (0=Sunday … 6=Saturday) when HR has not plotted the day"],
  ["attendance.rest_day_2", "6", "number", "attendance", "Default second day off (0=Sunday … 6=Saturday, blank for none) when HR has not plotted the day"],
  ["attendance.lunch_start", "12:00", "time", "attendance", "Default lunch start (one hour, unpaid)"],
  ["attendance.am_break_start", "10:00", "time", "attendance", "Default morning break start (15 minutes, paid)"],
  ["attendance.pm_break_start", "15:00", "time", "attendance", "Default afternoon break start (15 minutes, paid)"],
  ["attendance.short_break_minutes", "15", "number", "attendance", "Paid morning and afternoon break (minutes each; counted only when punched)"],
  ["retirement.vesting_years", "25", "number", "retirement", "Years of service before the company share of the retirement fund can be withdrawn"],
  ["payroll.days_per_year", "261", "number", "payroll", "Days/year used to derive a daily rate from a monthly salary (261 = 5-day week)"],
  ["payroll.ot_multiplier_regular", "1.25", "number", "payroll", "Overtime on an ordinary day (verify against current DOLE rules)"],
  ["payroll.ot_multiplier_rest_day", "1.69", "number", "payroll", "Overtime on a day off or special day, beyond 8 hours (169%)"],
  ["payroll.rest_day_multiplier", "1.3", "number", "payroll", "Approved work on a day off, first 8 hours (130%)"],
  ["payroll.holiday_multiplier_regular_rest_day", "2.6", "number", "payroll", "Work on a regular holiday that falls on a day off (260%)"],
  ["payroll.holiday_multiplier_special_rest_day", "1.5", "number", "payroll", "Work on a special non-working day that falls on a day off (150%)"],
  ["payroll.ot_multiplier_holiday", "2.6", "number", "payroll", "Overtime on a regular holiday"],
  ["payroll.holiday_multiplier_regular", "2", "number", "payroll", "Regular holiday worked: double pay (200% of the basic daily rate)"],
  ["payroll.holiday_multiplier_special", "1.3", "number", "payroll", "Special non-working day worked: 30% extra (130% of the basic daily rate)"],
  ["payroll.night_diff_rate", "0.10", "number", "payroll", "Night differential premium (22:00–06:00)"],
  ["payroll.contribution_schedule", "split", "string", "payroll", "split = divide monthly contributions across periods; last = deduct in the last period of the month"],
  ["payroll.allow_unverified_rules", "0", "boolean", "payroll", "Allow payroll to run on statutory rules not yet verified by an administrator"],
  ["leave.carry_over_days", "0", "number", "leave", "Unused days carried into the next year"],
  ["self.show_salary", "1", "boolean", "self_service", "Show employees their own salary rate in My Profile"],
  ["company.name", env.company.name, "string", "company", "Company name printed on documents"],
  ["company.address", env.company.address, "string", "company", "Company address printed on documents"],
];
for (const [k, v, t, g, d] of SETTINGS) {
  await exec("INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES (?,?,?,?,?)", [k, v, t, g, d]);
}

// ---------------------------------------------------------------- statutory REFERENCE DEFAULTS (is_verified = 0)
// These are starting values only. Rates and brackets change by law/circular; an administrator must verify each
// row against current SSS, PhilHealth, Pag-IBIG and BIR issuances before the first real payroll.
const hasRules = await selectOne("SELECT COUNT(*) AS n FROM statutory_contribution_rules");
if (!hasRules.n) {
  const rules = [
    ["SSS", "2025-01-01", 0.05, 0.10, 5000, 35000, 500, 15000, 10, 30, "RA 11199 (Social Security Act of 2018), 2025 schedule", "Monthly Salary Credit rounded to nearest ₱500; EC is employer-only (₱10 below ₱15,000 MSC, ₱30 otherwise)."],
    ["PHILHEALTH", "2025-01-01", 0.025, 0.025, 10000, 100000, 0, 0, 0, 0, "RA 11223 (Universal Health Care Act), 2025 schedule", "5% premium shared equally; income floor ₱10,000, ceiling ₱100,000."],
    ["PAGIBIG", "2024-02-01", 0.02, 0.02, 0, 10000, 0, 0, 0, 0, "HDMF circular on maximum fund salary of ₱10,000 (Feb 2024)", "2% each on a monthly fund salary capped at ₱10,000; the employee share is 1% at ₱1,500 or below."],
  ];
  for (const r of rules) {
    await exec(
      `INSERT INTO statutory_contribution_rules
        (agency, effective_from, employee_rate, employer_rate, salary_floor, salary_ceiling, rounding_step,
         ec_threshold, ec_amount_low, ec_amount_high, source_reference, notes, low_income_ceiling, low_income_employee_rate, is_verified)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, [...r, ...(r[0] === "PAGIBIG" ? [1500, 0.01] : [0, 0])]);
  }
  const brackets = [
    [0, 250000, 0, 0], [250000, 400000, 0, 0.15], [400000, 800000, 22500, 0.20],
    [800000, 2000000, 102500, 0.25], [2000000, 8000000, 402500, 0.30], [8000000, null, 2202500, 0.35],
  ];
  for (const [from, to, base, rate] of brackets) {
    await exec(
      `INSERT INTO withholding_tax_brackets (effective_from, annual_from, annual_to, base_tax, rate, source_reference, is_verified)
       VALUES ('2023-01-01',?,?,?,?,'RA 10963 (TRAIN) graduated schedule, 2023 onwards',0)`, [from, to, base, rate]);
  }
  log("✅ statutory reference defaults seeded (UNVERIFIED — verify before real payroll)");
}

// ---------------------------------------------------------------- organisation starter (needed to link staff accounts)
await exec("INSERT IGNORE INTO departments (code, name, description) VALUES ('ADMIN','Administration','Legacy organisation record')");
await exec("UPDATE departments SET is_active = 0 WHERE code = 'ADMIN'");
const departments = [
  ["HR", "HR", "Human Resources"],
  ["PAYROLL_ACCOUNTING", "Payroll/Accounting", "Accounting, payroll and employee self-service"],
  ["CRM", "CRM", "Customer relationship management and sales"],
  ["INVENTORY", "Inventory", "Inventory, purchasing and supplier operations"],
];
const positionsByDepartment = {
  HR: ["HR Super Admin", "HR Supervisor", "HR Staff"],
  PAYROLL_ACCOUNTING: ["Accounting Supervisor", "Accounting Staff", "Payroll Staff", "Employee (ESS)"],
  CRM: ["CRM Manager", "Team Leader", "Agent"],
  INVENTORY: ["Inventory Manager", "Inventory Supervisor", "Inventory Staff"],
};
for (const [code, name, description] of departments) {
  await exec("INSERT INTO departments (code, name, description, is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), is_active = 1", [code, name, description]);
  const department = await selectOne("SELECT id FROM departments WHERE code = ?", [code]);
  for (const title of positionsByDepartment[code]) {
    await exec("INSERT INTO positions (department_id, title, is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE is_active = 1, deleted_at = NULL", [department.id, title]);
  }
}
await exec("UPDATE positions p JOIN departments d ON d.id = p.department_id SET p.is_active = 0, p.deleted_at = COALESCE(p.deleted_at, NOW()) WHERE d.code = 'CRM' AND p.title = 'Customer Account'");
await exec("UPDATE positions p JOIN departments d ON d.id = p.department_id SET p.is_active = 0, p.deleted_at = COALESCE(p.deleted_at, NOW()) WHERE d.code = 'INVENTORY' AND p.title = 'Supplier'");

// ---------------------------------------------------------------- first Accounting Supervisor (the department head, who also manages accounts)
const adminRole = await selectOne("SELECT id FROM roles WHERE code = 'accounting_supervisor'");
const email = (process.env.ADMIN_EMAIL || "").toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env (run `npm run setup`).");
const existing = await selectOne("SELECT id FROM users WHERE email = ?", [email]);
if (!existing) {
  const problem = checkPassword(password, email);
  if (problem) throw new Error(`ADMIN_PASSWORD rejected: ${problem}`);
  const hash = await bcrypt.hash(password, 12);
  await exec(
    "INSERT INTO users (role_id, email, full_name, password_hash, must_change_password) VALUES (?,?,?,?,1)",
    [adminRole.id, email.toLowerCase(), process.env.ADMIN_NAME || "System Administrator", hash]
  );
  log(`✅ Accounting Supervisor created: ${email} (must change password at first login)`);
} else {
  log("ℹ️  First Accounting Supervisor already exists — unchanged");
}

await sequelize.close();
