// HR pull sync. HR is pull-only: it sends no events and has no /events endpoint (team decision 2026-11-16). Every 15
// minutes (lib/scheduler.js) and on "Sync now" (System → Integration), JVzPay reads HR's departments, employees and
// approved compensation and applies them through the SAME handlers as the HR events (DepartmentUpserted,
// EmployeeCreated/Updated, EmployeeStatusChanged, EmployeeCompensationApproved), so both paths follow one set of rules.
// Resigned or Terminated in HR deactivates the ESS account (integrationService.js, disableSeparatedAccess).
//
// HR API (HR_API_URL + HR_API_PREFIX, Authorization: Bearer HR_API_TOKEN):
//   GET /departments?page=   GET /employees?page=   GET /employees/{identifier}   GET /payroll/employees/{identifier}/compensation
import { select, selectOne, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { clearSettingsCache, getSetting } from "../lib/settings.js";
import { callApp, targetConfig, hrHandlers, EventError } from "./integrationService.js";
import { listOf, totalPagesOf, recordOf, mapDepartment, mapEmployee, mapCompensation, separationDate, HrMappingError } from "./hrMapping.js";

export const SYNC_EVERY_MS = 15 * 60 * 1000;
const SETTING = "integration.hr_sync";
const SYSTEM = { id: null, full_name: "HR sync", role_code: "system" };
const manilaToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
// HR: GET /payroll/employees/{identifier}/compensation, one employee per call (HR_COMPENSATION_PATH may change it)
const COMPENSATION_TEMPLATE = () => `/${String(process.env.HR_COMPENSATION_PATH || "/payroll/employees/{identifier}/compensation").replace(/^\/+/, "")}`;
const compensationPath = (id) => COMPENSATION_TEMPLATE().replace("{identifier}", encodeURIComponent(id));

/** One employee's approved compensation from HR (none when HR answers 404). A list answer is read as versions. */
async function hrCompensation(employeeId) {
  const body = await hrGet(compensationPath(employeeId));
  if (body === null) return [];
  const items = Array.isArray(body) || listOf(body).length ? listOf(body) : [recordOf(body)];
  return items.map((item) => mapCompensation(item, employeeId)).filter(Boolean);
}

export class HrUnavailableError extends Error {}

/** GET from HR; throws HrUnavailableError with a readable reason when HR cannot answer. Returns null on 404. */
async function hrGet(path) {
  let res;
  try {
    res = await callApp("hr", "GET", path);
  } catch (e) {
    throw new HrUnavailableError(e.name === "TimeoutError" ? "HR did not answer within 10 seconds" : `HR could not be reached (${e.cause?.code || e.message})`);
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new HrUnavailableError(`HR refused JVzPay's API key (HTTP ${res.status}); check HR_API_TOKEN`);
  if (!res.ok) throw new HrUnavailableError(`HR answered HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new HrUnavailableError("HR's answer was not JSON"); }
}

/** Every item of a paged HR list. */
async function hrList(path) {
  const out = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await hrGet(`${path}${sep}page=${page}&per_page=100`);
    if (body === null) return null;
    const items = listOf(body);
    out.push(...items);
    pages = totalPagesOf(body);
    if (!items.length) break;
  }
  return out;
}

const eventFor = (kind) => ({ event_id: `hr-sync:${kind}:${Date.now()}` });

/** Apply one HR employee record (already mapped) through the event handlers. Returns what happened. */
async function applyEmployee(data, rawItem) {
  return tx(async (trx) => {
    const cur = await selectOne("SELECT id, employment_status FROM employees WHERE hr_employee_id = ? AND deleted_at IS NULL", [data.employee_id], trx);
    if (!cur) {
      await hrHandlers.employeeUpsert(data, eventFor("employee"), trx);
      return "created";
    }
    const changed = cur.employment_status !== data.employment_status;
    // the master data first, keeping the current status; then a status change goes through EmployeeStatusChanged
    // (employment history, separation date, ESS access removed when Resigned/Terminated)
    await hrHandlers.employeeUpsert({ ...data, employment_status: cur.employment_status }, eventFor("employee"), trx);
    if (changed) {
      const leaving = ["resigned", "terminated"].includes(data.employment_status);
      const when = separationDate(rawItem, manilaToday());
      await hrHandlers.employeeStatus({ employee_id: data.employee_id, employment_status: data.employment_status, effective_date: when, ...(leaving ? { separation_date: when } : {}) }, eventFor("status"), trx);
      return leaving ? "separated" : "status_changed";
    }
    return "updated";
  });
}

/** Apply one approved compensation unless JVzPay already has that exact version. */
async function applyCompensation(c) {
  const emp = await selectOne("SELECT id FROM employees WHERE hr_employee_id = ? AND deleted_at IS NULL", [c.employee_id]);
  if (!emp) return "unknown_employee";
  const same = await selectOne(
    "SELECT id FROM salary_history WHERE employee_id = ? AND effective_date = ? AND new_amount = ? AND rate_basis = ? AND verification_status <> 'rejected' LIMIT 1",
    [emp.id, c.effective_date, Number(c.basic_salary).toFixed(2), c.rate_basis]);
  if (same) return "unchanged";
  await tx((trx) => hrHandlers.compensation(c, eventFor("compensation"), trx));
  return "recorded";
}

let running = null;

/** One full sync. `trigger` is "schedule" or "manual"; `req` (manual) is audited as the person who asked. */
export async function syncFromHr({ req = null, trigger = "schedule" } = {}) {
  if (running) return running; // never two syncs at once: a second caller gets the running one's result
  running = runSync(req, trigger).finally(() => { running = null; });
  return running;
}

async function runSync(req, trigger) {
  const startedAt = new Date();
  const s = {
    at: startedAt.toISOString(), trigger, ok: false, error: null,
    departments: { seen: 0, saved: 0, failed: 0 },
    employees: { seen: 0, created: 0, updated: 0, status_changed: 0, separated: 0, failed: 0 },
    compensation: { seen: 0, recorded: 0, unchanged: 0, failed: 0, endpoint: COMPENSATION_TEMPLATE() },
    problems: [],
  };
  const problem = (where, msg) => { if (s.problems.length < 30) s.problems.push(`${where}: ${String(msg).slice(0, 200)}`); };
  try {
    if (!targetConfig("hr").connected) throw new HrUnavailableError("HR_API_URL is not set");

    const depts = (await hrList("/departments")) || [];
    const byId = new Map();
    for (const item of depts) {
      s.departments.seen++;
      try {
        const d = mapDepartment(item);
        if (item.id !== undefined) byId.set(String(item.id), { code: d.department_code, name: d.department_name });
        await tx((trx) => hrHandlers.department(d, eventFor("department"), trx));
        s.departments.saved++;
      } catch (e) { s.departments.failed++; problem("department", e.message); }
    }

    const people = await hrList("/employees");
    if (people === null) throw new HrUnavailableError("HR has no /employees endpoint at this address");
    const synced = [];
    for (const item of people) {
      s.employees.seen++;
      try {
        const data = mapEmployee(item, byId);
        s.employees[await applyEmployee(data, item)]++;
        synced.push(data.employee_id);
      } catch (e) {
        s.employees.failed++;
        problem(`employee ${item?.employee_id ?? item?.employee_no ?? "?"}`, e instanceof HrMappingError || e instanceof EventError ? e.message : `could not be saved (${e.message})`);
      }
    }

    const comps = [];
    for (const id of synced) {
      try { comps.push(...(await hrCompensation(id))); }
      catch (e) { if (e instanceof HrUnavailableError) throw e; s.compensation.failed++; problem(`compensation ${id}`, e.message); }
    }
    for (const c of comps) {
      s.compensation.seen++;
      try {
        const r = await applyCompensation(c);
        if (r === "unknown_employee") { s.compensation.failed++; problem(`compensation ${c.employee_id}`, "employee not in HR's employee list"); }
        else s.compensation[r]++;
      } catch (e) { s.compensation.failed++; problem(`compensation ${c.employee_id}`, e.message); }
    }
    s.ok = true;
  } catch (e) {
    s.error = e instanceof HrUnavailableError ? e.message : `Sync stopped: ${e.message}`;
    if (!(e instanceof HrUnavailableError)) console.error("[hr-sync] failed:", e);
  }
  s.seconds = Math.round((Date.now() - startedAt.getTime()) / 100) / 10;
  await saveSummary(s);
  const changes = s.employees.created + s.employees.status_changed + s.employees.separated + s.compensation.recorded;
  if (trigger === "manual" || changes || !s.ok || s.problems.length) {
    await audit(req, {
      action: s.ok ? "hr_sync_completed" : "hr_sync_failed", module: "integration", actor: req ? undefined : SYSTEM, recordType: "hr_sync", recordId: trigger,
      remarks: s.error || `${s.employees.seen} employees (${s.employees.created} new, ${s.employees.status_changed + s.employees.separated} status changes), ${s.compensation.recorded} salary versions, ${s.problems.length} problem(s)`,
    });
  }
  return s;
}

async function saveSummary(s) {
  await exec(
    `INSERT INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES (?, ?, 'json', 'integration_status', 'Result of the last HR pull sync (written by JVzPay)')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [SETTING, JSON.stringify(s)]);
  clearSettingsCache();
}

export const lastSync = () => getSetting(SETTING, null);

/**
 * Fetch one employee from HR (GET /employees/{identifier}) and apply it, e.g. right after a successful registration
 * check when the 15-minute sync has not brought the new hire yet. Returns JVzPay's employee row, or null.
 */
export async function syncOneEmployee(identifier) {
  const body = await hrGet(`/employees/${encodeURIComponent(identifier)}`);
  if (body === null) return null;
  const item = recordOf(body);
  // HR may name only the department's id: read HR's departments to know its code (as the full sync does)
  const byId = new Map();
  if (!item.department_code && !item.department?.code) {
    for (const d of (await hrList("/departments")) || []) {
      try { const m = mapDepartment(d); if (d.id !== undefined) byId.set(String(d.id), { code: m.department_code, name: m.department_name }); } catch { /* skip */ }
    }
  }
  const data = mapEmployee(item, byId);
  await applyEmployee(data, item);
  try { for (const c of await hrCompensation(data.employee_id)) await applyCompensation(c); } catch { /* the next full sync reports it */ }
  return selectOne("SELECT * FROM employees WHERE hr_employee_id = ? AND deleted_at IS NULL", [data.employee_id]);
}

/** For the Integration page: employees whose snapshot came from HR. */
export const hrEmployeeCount = async () => Number((await select("SELECT COUNT(*) AS n FROM employees WHERE hr_employee_id IS NOT NULL AND deleted_at IS NULL"))[0].n);
