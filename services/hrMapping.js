// HR's pull API (HR sends no events) → the data of JVzPay's HR event handlers. Pure functions, unit-tested.
//
// HR's exact JSON was not available when this was written, so each field accepts the names JVzPay documented to HR
// (docs/API_INTEGRATION.md §2.1, the EmployeeCreated fields) plus the usual alternatives. To follow HR's final shape,
// change only this file. Every accepted name is listed in docs/API_INTEGRATION.md §7.
export class HrMappingError extends Error {}
const fail = (m) => { throw new HrMappingError(m); };

const blank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
/** First non-empty value among the keys (a key may be a path such as "department.code"). */
export function pick(o, ...keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((x, p) => (x && typeof x === "object" ? x[p] : undefined), o);
    if (!blank(v) && typeof v !== "object") return typeof v === "string" ? v.trim() : v;
  }
  return undefined;
}
const date10 = (v) => (blank(v) ? undefined : /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : undefined);

/** The list inside a paged answer: {items}, {data}, {employees}, {departments}, {results}, {records} or a bare array. */
export function listOf(body) {
  if (Array.isArray(body)) return body;
  for (const k of ["items", "data", "employees", "departments", "compensations", "compensation", "results", "records"]) if (Array.isArray(body?.[k])) return body[k];
  return [];
}
/** Total pages of a paged answer ({page, total_pages}, Laravel's meta.last_page, …); 1 when it does not say. */
export function totalPagesOf(body) {
  const n = Number(body?.total_pages ?? body?.meta?.last_page ?? body?.last_page ?? body?.pagination?.total_pages ?? body?.meta?.total_pages ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : 1;
}
/** One record of a detail answer: the object itself, or {data}/{employee}. */
export const recordOf = (body) => (body?.data && !Array.isArray(body.data) ? body.data : body?.employee && typeof body.employee === "object" ? body.employee : body);

const STATUS = {
  active: "active", regular: "active", employed: "active",
  on_leave: "on_leave", "on leave": "on_leave", leave: "on_leave",
  suspended: "suspended", inactive: "suspended",
  resigned: "resigned",
  terminated: "terminated", separated: "terminated", dismissed: "terminated",
};
/** HR's employment status in JVzPay's words (active, on_leave, suspended, resigned, terminated). */
export function employmentStatus(v) {
  if (blank(v)) return undefined;
  const s = STATUS[String(v).trim().toLowerCase().replace(/-/g, "_")] ?? STATUS[String(v).trim().toLowerCase()];
  if (!s) fail(`unknown employment status "${String(v).slice(0, 30)}"`);
  return s;
}
const TYPES = { regular: "regular", permanent: "regular", "full_time": "regular", probationary: "probationary", contractual: "contractual", contract: "contractual", part_time: "part_time", seasonal: "seasonal" };
const employmentType = (v) => (blank(v) ? undefined : TYPES[String(v).trim().toLowerCase().replace(/[- ]/g, "_")]);

export function mapDepartment(item) {
  const code = pick(item, "department_code", "code");
  if (!code) fail("department without a code");
  const status = String(pick(item, "status") ?? "").toLowerCase();
  return { department_code: String(code), department_name: pick(item, "department_name", "name"), is_active: item.is_active !== false && item.is_active !== 0 && status !== "inactive" };
}

/**
 * One HR employee → EmployeeCreated/EmployeeUpdated data. `departments` maps HR's department id to {code, name}
 * (from /departments) for an employee that carries only a department id.
 */
export function mapEmployee(item, departments = new Map()) {
  const employeeId = pick(item, "employee_id", "employee_no", "employee_number");
  if (!employeeId) fail("employee without employee_id");
  let first = pick(item, "first_name", "given_name"), last = pick(item, "last_name", "surname", "family_name");
  const full = pick(item, "full_name", "name");
  if ((!first || !last) && full) {
    const words = String(full).split(/\s+/);
    last = last || words.pop();
    first = first || words.join(" ");
  }
  const deptId = pick(item, "department_id", "department.id");
  const dept = deptId !== undefined ? departments.get(String(deptId)) : undefined;
  const department_code = pick(item, "department_code", "department.code") ?? dept?.code;
  const data = {
    employee_id: String(employeeId),
    employee_no: String(pick(item, "employee_no", "employee_number") ?? employeeId),
    first_name: first, middle_name: pick(item, "middle_name"), last_name: last, suffix: pick(item, "suffix"),
    birth_date: date10(pick(item, "birth_date", "date_of_birth")),
    email: pick(item, "email", "onboarding_email", "personal_email", "work_email"),
    phone: pick(item, "phone", "mobile", "mobile_number", "contact_number"),
    department_code: department_code !== undefined ? String(department_code) : undefined,
    department_name: pick(item, "department_name", "department.name") ?? dept?.name,
    position_title: pick(item, "position_title", "position.title", "position.name", "position", "job_title"),
    employment_type: employmentType(pick(item, "employment_type")),
    employment_status: employmentStatus(pick(item, "employment_status", "status")) ?? "active",
    date_hired: date10(pick(item, "date_hired", "hire_date", "hired_at", "date_joined", "start_date")),
    verification_reference: pick(item, "unique_code", "employee_unique_code", "employee_code", "verification_reference", "verification_code"),
    employee_code: pick(item, "employee_code", "unique_code", "employee_unique_code"),
  };
  const sup = pick(item, "supervisor_employee_id", "immediate_supervisor_employee_id", "team_leader_employee_id", "supervisor.employee_id");
  if (sup !== undefined || "supervisor_employee_id" in item) data.supervisor_employee_id = sup ?? null;
  const missing = ["first_name", "last_name", "department_code", "position_title", "date_hired"].filter((k) => blank(data[k]));
  if (missing.length) fail(`employee ${employeeId}: HR did not send ${missing.join(", ")}`);
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  return data;
}

/** When HR says the employee left (separation date, or the date of the status change); defaults to `today`. */
export const separationDate = (item, today) => date10(pick(item, "separation_date", "date_separated", "status_effective_date", "effective_date")) || today;

/** One approved compensation (from HR's /payroll endpoint, or embedded in the employee) → EmployeeCompensationApproved data. */
export function mapCompensation(item, employeeId = undefined) {
  const id = employeeId ?? pick(item, "employee_id", "employee_no", "employee.employee_id");
  const salary = pick(item, "basic_salary", "monthly_salary", "basic_pay", "salary", "amount");
  if (!id || salary === undefined) return null; // no compensation in this record
  const basis = String(pick(item, "rate_basis", "rate_type", "salary_basis") ?? "monthly").toLowerCase();
  const effective = date10(pick(item, "effective_date", "effective_from", "approved_at", "date_effective"));
  if (!effective) fail(`compensation of ${id}: HR did not send effective_date`);
  const freq = pick(item, "pay_frequency");
  const allowances = Array.isArray(item.allowances)
    ? item.allowances.map((a) => ({ code: pick(a, "code", "component_code"), amount: pick(a, "amount") })).filter((a) => a.code)
    : undefined;
  const out = {
    employee_id: String(id), basic_salary: salary, rate_basis: ["daily", "day"].includes(basis) ? "daily" : "monthly", effective_date: effective,
    pay_frequency: freq ? String(freq).toLowerCase().replace(/[- ]/g, "_") : undefined,
    allowances, approval_reference: pick(item, "approval_reference", "reference_no"),
    compensation_version_id: pick(item, "compensation_version_id", "version_id", "version"),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ---- ESS registration check (POST {HR}/employees/verify → {match, eligible, mismatches, employee}) ------------------------
const FIELD_LABELS = {
  employee_id: "Employee ID", employee_no: "Employee ID", full_name: "Full name", name: "Full name", first_name: "Full name", last_name: "Full name",
  email: "Email", department: "Department", department_code: "Department", department_id: "Department", position: "Position",
  position_title: "Position", verification_reference: "Unique code", unique_code: "Unique code", employee_code: "Unique code", code: "Unique code",
};
/** HR's mismatches (field names, or objects with a field) as form labels, never with HR's values. */
export function mismatchLabels(mismatches) {
  const list = Array.isArray(mismatches) ? mismatches : mismatches && typeof mismatches === "object" ? Object.keys(mismatches) : [];
  const labels = list.map((m) => {
    const f = String(typeof m === "object" && m ? m.field ?? m.name ?? "" : m).trim().toLowerCase();
    return FIELD_LABELS[f] || (f ? f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : null);
  }).filter(Boolean);
  return [...new Set(labels)];
}
