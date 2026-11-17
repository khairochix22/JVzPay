// HR's pull API (HR sends no events) → the data of JVzPay's HR event handlers. Pure functions, unit-tested.
//
// Field names follow HR's LIVE API as read on 2026-11-17 (GET /api/integration/v1/departments, /employees,
// /employees/{id}, /payroll/employees/{id}/compensation, POST /employees/verify):
//   lists      {success, data: {items: [...], page, page_size, total, total_pages}}   (departments: {success, data: [...]})
//   detail     {success, data: {...}}
//   department {department_id, department_code, department_name, description, active_headcount}
//   employee   {employee_id (HR's internal number), permanent_employee_id (the JV-YYYY-NNNNN Employee ID), employee_code
//               (the Employee Unique Code), first_name, last_name, full_name, email, phone_number,
//               department: {department_id, department_code, department_name}, position (text), employment_type,
//               work_schedule, reporting_supervisor_id (HR's internal number of the supervisor), hire_date, status}
//   compensation  data.compensation = {as_of, compensation_version_id, basic_salary, compensation_basis, components,
//               fixed_monthly_total}
//   verify     {match, eligible, mismatches: ["email", ...], employee?}; 404 {match: false} for an unknown Employee ID
// Not yet seen in a live answer (to confirm with HR's docs/integration-api-HR.md): the item shape of `components`, the
// status words other than "Active", the employment_type values and the `employee` object of a matching verify.
export class HrMappingError extends Error {}
const fail = (m) => { throw new HrMappingError(m); };

const blank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const text = (v) => (blank(v) ? undefined : String(v).trim());
const date10 = (v) => (blank(v) ? undefined : /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : undefined);

/** The list in HR's answer: data.items (paged lists) or data (departments). */
export function listOf(body) {
  if (Array.isArray(body?.data?.items)) return body.data.items;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}
/** Total pages of HR's paged answer (data.total_pages); 1 when it does not say. */
export function totalPagesOf(body) {
  const n = Number(body?.data?.total_pages ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : 1;
}
/** The record of HR's detail answer ({success, data}). */
export const recordOf = (body) => (body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : null);

// HR's status words (team list: Active, On Leave, Suspended, Resigned, Terminated) in JVzPay's words
const STATUS = { active: "active", "on leave": "on_leave", on_leave: "on_leave", suspended: "suspended", resigned: "resigned", terminated: "terminated" };
export function employmentStatus(v) {
  if (blank(v)) return undefined;
  const s = STATUS[String(v).trim().toLowerCase()];
  if (!s) fail(`unknown employment status "${String(v).slice(0, 30)}"`);
  return s;
}
const TYPES = ["regular", "probationary", "contractual", "part_time", "seasonal"];
const employmentType = (v) => { const t = blank(v) ? null : String(v).trim().toLowerCase().replace(/[- ]/g, "_"); return TYPES.includes(t) ? t : undefined; };

export function mapDepartment(item) {
  const code = text(item?.department_code);
  if (!code) fail("department without department_code");
  return { department_code: code, department_name: text(item.department_name), is_active: item.is_active !== false };
}

/** HR's internal employee number → JV Employee ID, from HR's employee list (to resolve reporting_supervisor_id). */
export function supervisorMap(items) {
  const m = new Map();
  for (const it of items || []) if (it?.employee_id !== undefined && !blank(it.permanent_employee_id)) m.set(String(it.employee_id), String(it.permanent_employee_id));
  return m;
}

/** An HR account without a JV Employee ID (HR's "System account" users) is not an employee: the sync skips it. */
export const isEmployeeRecord = (item) => !blank(item?.permanent_employee_id);

/**
 * One HR employee → EmployeeCreated/EmployeeUpdated data. `supervisors` (supervisorMap of HR's list) turns
 * reporting_supervisor_id into the supervisor's JV number; without the map the supervisor is left unchanged.
 */
export function mapEmployee(item, supervisors = null) {
  const jv = text(item?.permanent_employee_id);
  if (!jv) fail(`HR employee ${item?.employee_id ?? "?"} has no permanent_employee_id (Employee ID)`);
  const dept = item.department && typeof item.department === "object" ? item.department : {};
  const data = {
    employee_id: jv,
    employee_no: jv,
    first_name: text(item.first_name), last_name: text(item.last_name),
    email: text(item.email), phone: text(item.phone_number),
    department_code: text(dept.department_code), department_name: text(dept.department_name),
    position_title: text(item.position),
    employment_type: employmentType(item.employment_type),
    employment_status: employmentStatus(item.status) ?? "active",
    date_hired: date10(item.hire_date),
    verification_reference: text(item.employee_code),
    employee_code: text(item.employee_code),
  };
  if (supervisors) {
    const sup = item.reporting_supervisor_id;
    if (blank(sup)) data.supervisor_employee_id = null;
    else if (supervisors.has(String(sup))) data.supervisor_employee_id = supervisors.get(String(sup));
  }
  const missing = ["first_name", "last_name", "department_code", "position_title", "date_hired"].filter((k) => blank(data[k]));
  if (missing.length) fail(`employee ${jv}: HR did not send ${missing.join(", ").replace("department_code", "department.department_code").replace("position_title", "position").replace("date_hired", "hire_date")}`);
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  return data;
}

/** HR has no separation date field: a separation is dated on the day the sync sees it. */
export const separationDate = (item, today) => today;

/**
 * HR's approved compensation (data.compensation of GET /payroll/employees/{id}/compensation) → EmployeeCompensationApproved
 * data, or null when HR has no salary for the employee.
 */
export function mapCompensation(comp, employeeId) {
  if (!comp || typeof comp !== "object" || blank(comp.basic_salary) || !employeeId) return null;
  const basis = String(comp.compensation_basis ?? "monthly").toLowerCase();
  if (!["monthly", "daily"].includes(basis)) fail(`compensation of ${employeeId}: compensation_basis "${basis}" is not monthly or daily`);
  const effective = date10(comp.as_of);
  if (!effective) fail(`compensation of ${employeeId}: HR did not send as_of`);
  const out = {
    employee_id: String(employeeId), basic_salary: comp.basic_salary, rate_basis: basis, effective_date: effective,
    compensation_version_id: blank(comp.compensation_version_id) ? undefined : String(comp.compensation_version_id),
    // components: item shape not seen yet (HR's answers had none); code + amount assumed
    allowances: Array.isArray(comp.components) && comp.components.length ? comp.components.map((c) => ({ code: text(c.code ?? c.component_code), amount: c.amount })).filter((c) => c.code) : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ---- ESS registration check (POST {HR}/employees/verify → {match, eligible, mismatches, employee}) ------------------------
const FIELD_LABELS = {
  employee_id: "Employee ID", permanent_employee_id: "Employee ID", full_name: "Full name", first_name: "Full name", last_name: "Full name",
  email: "Email", department: "Department", department_code: "Department", position: "Position",
  employee_code: "Unique code", verification_reference: "Unique code",
};
/** HR's mismatches (field names, or objects with a field) as form labels, never with HR's values. */
export function mismatchLabels(mismatches) {
  const list = Array.isArray(mismatches) ? mismatches : mismatches && typeof mismatches === "object" ? Object.keys(mismatches) : [];
  const labels = list.map((m) => {
    const f = String(typeof m === "object" && m ? m.field ?? "" : m).trim().toLowerCase();
    return FIELD_LABELS[f] || (f ? f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : null);
  }).filter(Boolean);
  return [...new Set(labels)];
}
