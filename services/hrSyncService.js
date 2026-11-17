// HR pull sync. HR is pull-only: it sends no events and has no /events endpoint (team decision 2026-11-16). Every 15
// minutes (lib/scheduler.js) and on "Sync now" (System → Integration), JVzPay reads HR's departments, employees and
// approved compensation and applies them through the SAME handlers as the HR events (DepartmentUpserted,
// EmployeeCreated/Updated, EmployeeStatusChanged, EmployeeCompensationApproved), so both paths follow one set of rules.
// Resigned or Terminated in HR deactivates the ESS account (integrationService.js, disableSeparatedAccess).
//
// HR API (HR_API_URL + HR_API_PREFIX, Authorization: Bearer HR_API_TOKEN), shapes in hrMapping.js:
//   GET /departments    GET /employees?page=&page_size=    GET /payroll/employees/{employee_id}/compensation
// HR's {employee_id} in those paths is HR's INTERNAL number; JVzPay keys employees by the JV Employee ID
// (permanent_employee_id). HR accounts without a JV Employee ID ("System account") are skipped.
import { select, selectOne, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { clearSettingsCache, getSetting } from "../lib/settings.js";
import { callApp, targetConfig, hrHandlers, EventError } from "./integrationService.js";
import { listOf, totalPagesOf, recordOf, mapDepartment, mapEmployee, mapCompensation, separationDate, supervisorMap, isEmployeeRecord, HrMappingError } from "./hrMapping.js";

export const SYNC_EVERY_MS = 15 * 60 * 1000;
const SETTING = "integration.hr_sync";
const SYSTEM = { id: null, full_name: "HR sync", role_code: "system" };
const manilaToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
// HR: GET /payroll/employees/{identifier}/compensation, with HR's internal employee number (HR_COMPENSATION_PATH may change it)
const COMPENSATION_TEMPLATE = () => `/${String(process.env.HR_COMPENSATION_PATH || "/payroll/employees/{identifier}/compensation").replace(/^\/+/, "")}`;
const compensationPath = (hrInternalId) => COMPENSATION_TEMPLATE().replace("{identifier}", encodeURIComponent(hrInternalId));

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

/** Every item of a paged HR list (data.items, data.total_pages). */
async function hrList(path) {
  const out = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await hrGet(`${path}${sep}page=${page}&page_size=100`);
    if (body === null) return null;
    const items = listOf(body);
    out.push(...items);
    pages = totalPagesOf(body);
    if (!items.length) break;
  }
  return out;
}

/** One employee's approved compensation (data.compensation), by HR's internal number; [] when HR has none. */
async function hrCompensation(hrInternalId, jvId) {
  const body = await hrGet(compensationPath(hrInternalId));
  const c = mapCompensation(recordOf(body)?.compensation, jvId);
  return c ? [c] : [];
}

const eventFor = (kind) => ({ event_id: `hr-sync:${kind}:${Date.now()}` });

/** Apply one HR employee record (already mapped) through the event handlers. Returns what happened. */
async function applyEmployee(data) {
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
      const when = separationDate(data, manilaToday());
      await hrHandlers.employeeStatus({ employee_id: data.employee_id, employment_status: data.employment_status, effective_date: when, ...(leaving ? { separation_date: when } : {}) }, eventFor("status"), trx);
      return leaving ? "separated" : "status_changed";
    }
    return "updated";
  });
}

/**
 * Apply one approved compensation unless it is what JVzPay already pays: HR's as_of moves with time, so the version is
 * compared by amount and basis (a changed salary is recorded, effective on HR's as_of date).
 */
async function applyCompensation(c) {
  const emp = await selectOne("SELECT id FROM employees WHERE hr_employee_id = ? AND deleted_at IS NULL", [c.employee_id]);
  if (!emp) return "unknown_employee";
  const latest = await selectOne(
    "SELECT new_amount, rate_basis FROM salary_history WHERE employee_id = ? AND verification_status <> 'rejected' ORDER BY effective_date DESC, id DESC LIMIT 1", [emp.id]);
  if (latest && Number(latest.new_amount).toFixed(2) === Number(c.basic_salary).toFixed(2) && latest.rate_basis === c.rate_basis) return "unchanged";
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
    employees: { seen: 0, created: 0, updated: 0, status_changed: 0, separated: 0, skipped: 0, failed: 0 },
    compensation: { seen: 0, recorded: 0, unchanged: 0, failed: 0, endpoint: COMPENSATION_TEMPLATE() },
    problems: [],
  };
  const problem = (where, msg) => { if (s.problems.length < 30) s.problems.push(`${where}: ${String(msg).slice(0, 200)}`); };
  try {
    if (!targetConfig("hr").connected) throw new HrUnavailableError("HR_API_URL is not set");

    for (const item of (await hrList("/departments")) || []) {
      s.departments.seen++;
      try {
        await tx((trx) => hrHandlers.department(mapDepartment(item), eventFor("department"), trx));
        s.departments.saved++;
      } catch (e) { s.departments.failed++; problem("department", e.message); }
    }

    const people = await hrList("/employees");
    if (people === null) throw new HrUnavailableError("HR has no /employees endpoint at this address");
    const supervisors = supervisorMap(people);
    const synced = [];
    for (const item of people) {
      s.employees.seen++;
      if (!isEmployeeRecord(item)) { s.employees.skipped++; continue; } // HR's system accounts have no JV Employee ID
      try {
        const data = mapEmployee(item, supervisors);
        s.employees[await applyEmployee(data)]++;
        synced.push({ hrId: item.employee_id, jv: data.employee_id });
      } catch (e) {
        s.employees.failed++;
        problem(`employee ${item?.permanent_employee_id ?? item?.employee_id ?? "?"}`, e instanceof HrMappingError || e instanceof EventError ? e.message : `could not be saved (${e.message})`);
      }
    }

    for (const { hrId, jv } of synced) {
      let comps;
      try { comps = await hrCompensation(hrId, jv); }
      catch (e) { if (e instanceof HrUnavailableError) throw e; s.compensation.failed++; problem(`compensation ${jv}`, e.message); continue; }
      for (const c of comps) {
        s.compensation.seen++;
        try {
          const r = await applyCompensation(c);
          if (r === "unknown_employee") { s.compensation.failed++; problem(`compensation ${jv}`, "employee not in JVzPay"); }
          else s.compensation[r]++;
        } catch (e) { s.compensation.failed++; problem(`compensation ${jv}`, e.message); }
      }
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
 * Bring one employee from HR right after HR confirmed their registration, when the 15-minute sync has not brought them
 * yet. HR's list is searched by the JV Employee ID; a new hire HR does not list yet is taken from the verify answer's
 * `employee` (pass it as `fromVerify`). Returns JVzPay's employee row, or null when HR has no usable record.
 */
export async function syncOneEmployee(jvId, fromVerify = null) {
  const people = (await hrList("/employees")) || [];
  let item = people.find((p) => String(p.permanent_employee_id || "").toUpperCase() === String(jvId).toUpperCase());
  if (!item && fromVerify && isEmployeeRecord(fromVerify)) item = fromVerify;
  if (!item) return null;
  const data = mapEmployee(item, supervisorMap(people));
  await applyEmployee(data);
  if (item.employee_id !== undefined) {
    try { for (const c of await hrCompensation(item.employee_id, data.employee_id)) await applyCompensation(c); } catch { /* the next full sync reports it */ }
  }
  return selectOne("SELECT * FROM employees WHERE hr_employee_id = ? AND deleted_at IS NULL", [data.employee_id]);
}

/** For the Integration page: employees whose snapshot came from HR. */
export const hrEmployeeCount = async () => Number((await select("SELECT COUNT(*) AS n FROM employees WHERE hr_employee_id IS NOT NULL AND deleted_at IS NULL"))[0].n);
