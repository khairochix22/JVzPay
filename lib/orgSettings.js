// Organisation settings that follow HR's position titles (team decision 2026-11-16). Pure, unit-tested; read from .env.
//
// POSITION_ROLES: which HR position titles in the Payroll/Accounting department get a working JVzPay role.
//   Default "Accounting Supervisor=accounting_supervisor,Accounting Staff=accounting_staff,Payroll Staff=payroll_staff".
//   Any other title, and every title of every other department, gets the Self-Service role "employee".
// DEPARTMENT_SUPERVISOR_TITLES: the supervisors/managers of each department, highest first, who give the first approval
//   of their department's requests when HR names no immediate supervisor.
//   Default "CRM=CRM Manager|Team Leader;INVENTORY=Inventory Manager|Inventory Supervisor;HR=HR Manager|HR Supervisor;
//            PAYROLL_ACCOUNTING=Accounting Supervisor".
// ACCOUNTING_DEPARTMENT_CODE: HR's code of the Payroll/Accounting department (default PAYROLL_ACCOUNTING).
export const ROLES = ["accounting_supervisor", "accounting_staff", "payroll_staff", "employee"];
const DEFAULT_ROLES = "Accounting Supervisor=accounting_supervisor,Accounting Staff=accounting_staff,Payroll Staff=payroll_staff";
const DEFAULT_SUPERVISORS = "CRM=CRM Manager|Team Leader;INVENTORY=Inventory Manager|Inventory Supervisor;HR=HR Manager|HR Supervisor;PAYROLL_ACCOUNTING=Accounting Supervisor";

/** Title comparison: case, accents, spaces and punctuation do not matter. */
export const normTitle = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export const accountingDepartment = () => String(process.env.ACCOUNTING_DEPARTMENT_CODE || "PAYROLL_ACCOUNTING").trim().toUpperCase();

/** "Title=role,Title=role" → Map(normalised title → role). Unknown roles are ignored. */
export function parsePositionRoles(text = process.env.POSITION_ROLES || DEFAULT_ROLES) {
  const map = new Map();
  for (const pair of String(text).split(",")) {
    const [title, role] = pair.split("=").map((x) => (x || "").trim());
    if (title && ROLES.includes(role)) map.set(normTitle(title), role);
  }
  return map;
}

/** The JVzPay role of a new ESS account, from HR's department and position. */
export function roleForPosition(deptCode, positionTitle, roles = parsePositionRoles()) {
  if (String(deptCode || "").toUpperCase() !== accountingDepartment()) return "employee";
  return roles.get(normTitle(positionTitle)) || "employee";
}

/** "CODE=Title|Title;CODE=Title" → Map(department code → [normalised titles, highest first]). */
export function parseSupervisorTitles(text = process.env.DEPARTMENT_SUPERVISOR_TITLES || DEFAULT_SUPERVISORS) {
  const map = new Map();
  for (const part of String(text).split(";")) {
    const [code, titles] = part.split("=");
    if (code && titles) map.set(code.trim().toUpperCase(), titles.split("|").map(normTitle).filter(Boolean));
  }
  return map;
}

/**
 * The supervisor titles of a department that rank ABOVE this position (all of them for an ordinary employee, none for
 * the department's top title). Empty when the department has no supervisor titles.
 */
export function higherSupervisorTitles(deptCode, positionTitle, map = parseSupervisorTitles()) {
  const titles = map.get(String(deptCode || "").toUpperCase()) || [];
  const rank = titles.indexOf(normTitle(positionTitle));
  return rank === -1 ? titles : titles.slice(0, rank);
}

/** Is this position one of its department's supervisor titles? */
export const isSupervisorTitle = (deptCode, positionTitle, map = parseSupervisorTitles()) =>
  (map.get(String(deptCode || "").toUpperCase()) || []).includes(normTitle(positionTitle));
