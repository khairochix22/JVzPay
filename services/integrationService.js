// Integration layer: events in from HR, CRM and Inventory (integration_inbox), events out (integration_outbox),
// service tokens (integration_clients). See docs/API_INTEGRATION.md for the contract.
// Every inbound event is stored once (event_id / idempotency_key), applied inside one transaction, and logged.
import crypto from "node:crypto";
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";

export const SOURCES = { johnvivz_hr: "HR", johnvivz_crm: "CRM", johnvivz_inventory: "Inventory" };
const TARGET_ENV = { hr: "HR_API", crm: "CRM_API", inventory: "INVENTORY_API" };
const INTEGRATION_ACTOR = { id: null, full_name: "Integration", role_code: "system" };
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// ---- service tokens --------------------------------------------------------------------------------------------------------
export async function createClient(req, { source, name }) {
  if (!SOURCES[source]) throw badRequest("Choose the application this token is for.");
  const label = String(name || "").trim().slice(0, 120) || `${SOURCES[source]} application`;
  const token = `jvz_${crypto.randomBytes(32).toString("base64url")}`;
  const { insertId } = await exec(
    "INSERT INTO integration_clients (source, name, token_hash, token_hint, created_by) VALUES (?,?,?,?,?)",
    [source, label, sha256(token), token.slice(-6), req.user.id]);
  await audit(req, { action: "integration_token_created", module: "integration", recordType: "integration_client", recordId: insertId, next: { source, name: label } });
  return { id: insertId, token };
}

export async function revokeClient(req, id) {
  const c = await selectOne("SELECT * FROM integration_clients WHERE id = ?", [id]);
  if (!c) throw notFound("Token not found.");
  if (!c.is_active) return;
  await exec("UPDATE integration_clients SET is_active = 0, revoked_at = NOW(), revoked_by = ? WHERE id = ?", [req.user.id, id]);
  await audit(req, { action: "integration_token_revoked", module: "integration", recordType: "integration_client", recordId: id, previous: { source: c.source, name: c.name } });
}

export async function authenticateClient(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ""));
  if (!m) return null;
  const c = await selectOne("SELECT * FROM integration_clients WHERE token_hash = ? AND is_active = 1", [sha256(m[1])]);
  if (c) await exec("UPDATE integration_clients SET last_used_at = NOW() WHERE id = ?", [c.id]);
  return c;
}

export const listClients = () =>
  select(`SELECT c.*, u.full_name AS created_by_name FROM integration_clients c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.is_active DESC, c.id DESC`);

// ---- inbound events ----------------------------------------------------------------------------------------------------------
class EventError extends Error {}
const fail = (msg) => { throw new EventError(msg); };
const str = (v, max = 190) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);
const need = (data, keys) => { for (const k of keys) if (data[k] === undefined || data[k] === null || data[k] === "") fail(`data.${k} is required.`); };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const money = (v, label) => { const n = Number(v); if (!Number.isFinite(n)) fail(`${label} must be a number.`); return Math.round(n * 100) / 100; };

function checkEnvelope(client, e) {
  if (!e || typeof e !== "object") throw badRequest("The body must be a JSON event.");
  for (const k of ["event_id", "event_type", "source", "data"]) if (!e[k]) throw badRequest(`${k} is required.`);
  if (typeof e.data !== "object") throw badRequest("data must be an object.");
  if (e.source !== client.source) throw badRequest(`This token belongs to ${client.source}; the event says ${e.source}.`);
  if (String(e.event_id).length > 64) throw badRequest("event_id is too long.");
  if (!HANDLERS[e.source]?.[e.event_type]) throw badRequest(`JVzPay does not accept ${e.event_type} from ${e.source}.`);
}

/** Store and apply one event. Returns { status, httpStatus, error? }. */
export async function receiveEvent(client, e) {
  checkEnvelope(client, e);
  const dup = await selectOne("SELECT id, status FROM integration_inbox WHERE event_id = ? OR (idempotency_key IS NOT NULL AND idempotency_key = ?)", [String(e.event_id), str(e.idempotency_key)]);
  if (dup) {
    await exec("INSERT INTO integration_logs (direction, inbox_id, outcome, message) VALUES ('in', ?, 'duplicate', ?)", [dup.id, `Received again: ${e.event_id}`]);
    return { status: "duplicate", httpStatus: 200 };
  }
  let inboxId;
  try {
    ({ insertId: inboxId } = await exec(
      `INSERT INTO integration_inbox (event_id, idempotency_key, client_id, source, event_type, schema_version, entity_id, correlation_id, occurred_at, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [String(e.event_id), str(e.idempotency_key), client.id, e.source, e.event_type, Number(e.schema_version) || 1, str(e.entity_id, 80), str(e.correlation_id, 64),
        e.occurred_at && !Number.isNaN(Date.parse(e.occurred_at)) ? new Date(e.occurred_at) : null, JSON.stringify(e)]));
  } catch (err) {
    if (err?.original?.code === "ER_DUP_ENTRY" || err?.parent?.code === "ER_DUP_ENTRY") return { status: "duplicate", httpStatus: 200 };
    throw err;
  }
  return applyInbox(inboxId);
}

async function applyInbox(inboxId) {
  const row = await selectOne("SELECT * FROM integration_inbox WHERE id = ?", [inboxId]);
  const e = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  try {
    const ref = await tx(async (trx) => {
      const r = await HANDLERS[row.source][row.event_type](e.data, e, trx);
      await audit(null, { action: "integration_event_applied", module: "integration", actor: INTEGRATION_ACTOR, recordType: "integration_event", recordId: row.id, next: { source: row.source, event_type: row.event_type, entity_id: row.entity_id, result: r || null } }, trx);
      return r;
    });
    await exec("UPDATE integration_inbox SET status = 'processed', error = NULL, attempts = attempts + 1, processed_at = NOW(), result_ref = ? WHERE id = ?", [str(ref, 80), inboxId]);
    await exec("INSERT INTO integration_logs (direction, inbox_id, outcome, message) VALUES ('in', ?, 'processed', ?)", [inboxId, str(ref, 500)]);
    return { status: "processed", httpStatus: 202 };
  } catch (err) {
    const msg = err instanceof EventError ? err.message : `Could not be applied: ${err.message}`;
    await exec("UPDATE integration_inbox SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?", [msg.slice(0, 500), inboxId]);
    await exec("INSERT INTO integration_logs (direction, inbox_id, outcome, message) VALUES ('in', ?, 'failed', ?)", [inboxId, msg.slice(0, 500)]);
    if (!(err instanceof EventError)) console.error(`[integration] event ${row.event_id} failed:`, err);
    return { status: "failed", httpStatus: 422, error: msg };
  }
}

export async function retryInbox(req, id) {
  const row = await selectOne("SELECT id, status, event_type FROM integration_inbox WHERE id = ?", [id]);
  if (!row) throw notFound("Event not found.");
  if (row.status !== "failed") throw badRequest("Only failed events can be retried.");
  const r = await applyInbox(id);
  await audit(req, { action: "integration_event_retried", module: "integration", recordType: "integration_event", recordId: id, next: { result: r.status } });
  return r;
}

// ---- HR handlers: HR owns the employee master; JVzPay keeps a read-only snapshot per employee ----------------------------
const EMP_TYPES = ["regular", "probationary", "contractual", "part_time", "seasonal"];
const EMP_STATUS = ["active", "on_leave", "suspended", "resigned", "terminated"];

async function upsertDepartment(code, name, isActive, trx) {
  const c = str(code, 20)?.toUpperCase();
  if (!c) fail("department_code is required.");
  // an event without department_name keeps the department's current name (a new department starts with its code)
  const given = str(name, 100) || null;
  await exec(
    `INSERT INTO departments (code, name, description, is_active) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE name = IF(? IS NULL, name, VALUES(name)), is_active = VALUES(is_active)`,
    [c, given || c, "Synchronised from HR", isActive === false ? 0 : 1, given], trx);
  return selectOne("SELECT id FROM departments WHERE code = ?", [c], trx);
}

async function upsertPosition(deptId, title, isActive, trx) {
  const t = str(title, 100);
  if (!t) fail("position_title is required.");
  const cur = await selectOne("SELECT id FROM positions WHERE department_id = ? AND title = ?", [deptId, t], trx);
  if (cur) { await exec("UPDATE positions SET is_active = ?, deleted_at = IF(? = 1, NULL, deleted_at) WHERE id = ?", [isActive === false ? 0 : 1, isActive === false ? 0 : 1, cur.id], trx); return cur; }
  const { insertId } = await exec("INSERT INTO positions (department_id, title, is_active) VALUES (?,?,?)", [deptId, t, isActive === false ? 0 : 1], trx);
  return { id: insertId };
}

async function employeeUpsert(d, e, trx) {
  need(d, ["employee_id", "employee_no", "first_name", "last_name", "department_code", "position_title", "date_hired"]);
  if (!isDate(d.date_hired)) fail("data.date_hired must be YYYY-MM-DD.");
  if (d.birth_date && !isDate(d.birth_date)) fail("data.birth_date must be YYYY-MM-DD.");
  if (d.employment_type && !EMP_TYPES.includes(d.employment_type)) fail(`data.employment_type must be one of ${EMP_TYPES.join(", ")}.`);
  if (d.employment_status && !EMP_STATUS.includes(d.employment_status)) fail(`data.employment_status must be one of ${EMP_STATUS.join(", ")}.`);
  const dept = await upsertDepartment(d.department_code, d.department_name, true, trx);
  const pos = await upsertPosition(dept.id, d.position_title, true, trx);
  const hrId = str(d.employee_id, 40);
  const cur = await selectOne("SELECT id, employee_no FROM employees WHERE hr_employee_id = ?", [hrId], trx);
  const clash = await selectOne("SELECT id, hr_employee_id FROM employees WHERE employee_no = ?", [str(d.employee_no, 20)], trx);
  if (clash && (!cur || clash.id !== cur.id) && clash.hr_employee_id && clash.hr_employee_id !== hrId) fail(`Employee number ${d.employee_no} already belongs to HR employee ${clash.hr_employee_id}.`);
  const fields = {
    employee_no: str(d.employee_no, 20), first_name: str(d.first_name, 80), middle_name: str(d.middle_name, 80), last_name: str(d.last_name, 80), suffix: str(d.suffix, 10),
    birth_date: d.birth_date || null, email: str(d.email), phone: str(d.phone, 30), department_id: dept.id, position_id: pos.id,
    employment_type: d.employment_type || "regular", employment_status: d.employment_status || "active", date_hired: d.date_hired,
    hr_verification_hash: d.verification_reference ? sha256(String(d.verification_reference).trim().toUpperCase()) : undefined,
  };
  if (fields.hr_verification_hash === undefined) delete fields.hr_verification_hash;
  // the immediate supervisor or team leader (HR employee id), who gives the first approval of the employee requests
  if (d.supervisor_employee_id !== undefined) {
    if (d.supervisor_employee_id && String(d.supervisor_employee_id) === String(d.employee_id)) fail("data.supervisor_employee_id cannot be the employee.");
    fields.supervisor_hr_id = d.supervisor_employee_id ? str(d.supervisor_employee_id, 40) : null;
  }
  const id = cur?.id || clash?.id;
  if (id) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    await exec(`UPDATE employees SET ${sets}, hr_employee_id = ?, hr_synced_at = NOW(), hr_event_id = ?, deleted_at = NULL WHERE id = ?`, [...Object.values(fields), hrId, str(e.event_id, 64), id], trx);
    return `employee ${fields.employee_no} updated`;
  }
  // a new snapshot starts at ₱0 until HR sends the approved compensation (EmployeeCompensationApproved)
  const cols = Object.keys(fields);
  const { insertId } = await exec(
    `INSERT INTO employees (${cols.join(", ")}, basic_salary, rate_basis, pay_frequency, hr_employee_id, hr_synced_at, hr_event_id)
     VALUES (${cols.map(() => "?").join(", ")}, 0, 'monthly', 'semi_monthly', ?, NOW(), ?)`,
    [...Object.values(fields), hrId, str(e.event_id, 64)], trx);
  await exec("INSERT INTO employment_history (employee_id, change_type, to_department_id, to_position_id, to_status, to_type, effective_date, remarks) VALUES (?,'hired',?,?,?,?,?,'Received from HR')",
    [insertId, dept.id, pos.id, fields.employment_status, fields.employment_type, d.date_hired], trx);
  return `employee ${fields.employee_no} created`;
}

async function hrEmployee(hrId, trx) {
  const emp = await selectOne("SELECT * FROM employees WHERE hr_employee_id = ?", [str(hrId, 40)], trx);
  if (!emp) fail(`HR employee ${hrId} is not known to JVzPay yet. Send EmployeeCreated first.`);
  return emp;
}

async function employeeStatus(d, e, trx) {
  need(d, ["employee_id", "employment_status", "effective_date"]);
  if (!EMP_STATUS.includes(d.employment_status)) fail(`data.employment_status must be one of ${EMP_STATUS.join(", ")}.`);
  const emp = await hrEmployee(d.employee_id, trx);
  const leaving = ["resigned", "terminated"].includes(d.employment_status);
  const sep = leaving ? (d.separation_date || d.effective_date) : null;
  if (sep && !isDate(sep)) fail("data.separation_date must be YYYY-MM-DD.");
  await exec("UPDATE employees SET employment_status = ?, date_separated = ?, hr_synced_at = NOW(), hr_event_id = ? WHERE id = ?", [d.employment_status, sep, str(e.event_id, 64), emp.id], trx);
  await exec("INSERT INTO employment_history (employee_id, change_type, from_status, to_status, effective_date, remarks) VALUES (?,?,?,?,?,'Received from HR')",
    [emp.id, leaving ? "separation" : "status_change", emp.employment_status, d.employment_status, d.effective_date], trx);
  return `employee ${emp.employee_no} is now ${d.employment_status}${sep ? ` (payroll stops after ${sep})` : ""}`;
}

async function compensation(d, e, trx) {
  need(d, ["employee_id", "basic_salary", "rate_basis", "effective_date"]);
  if (!["monthly", "daily"].includes(d.rate_basis)) fail("data.rate_basis must be monthly or daily.");
  if (!isDate(d.effective_date)) fail("data.effective_date must be YYYY-MM-DD.");
  const freq = d.pay_frequency || "semi_monthly";
  if (!["semi_monthly", "monthly"].includes(freq)) fail("data.pay_frequency must be semi_monthly or monthly.");
  const amount = money(d.basic_salary, "basic_salary");
  if (amount < 0) fail("basic_salary cannot be negative.");
  const emp = await hrEmployee(d.employee_id, trx);
  const band = await selectOne(
    `SELECT b.minimum_monthly, b.maximum_monthly, p.title AS position_title
       FROM employees e
       JOIN positions p ON p.id = e.position_id AND p.is_active = 1 AND p.deleted_at IS NULL
       JOIN position_compensation_bands b ON b.position_id = p.id
        AND b.is_active = 1
        AND b.effective_from <= ?
        AND (b.effective_to IS NULL OR b.effective_to >= ?)
      WHERE e.id = ?
      ORDER BY b.effective_from DESC
      LIMIT 1`,
    [d.effective_date, d.effective_date, emp.id], trx);
  if (!band) fail(`No active compensation band is configured for ${emp.employee_no}'s position. HR must configure the position band before approving compensation.`);
  const monthlyEquivalent = d.rate_basis === "daily" ? amount * 261 / 12 : amount;
  if (monthlyEquivalent < Number(band.minimum_monthly) || monthlyEquivalent > Number(band.maximum_monthly)) {
    fail(`Basic salary for ${band.position_title} must be within the approved monthly band of ${Number(band.minimum_monthly).toFixed(2)} to ${Number(band.maximum_monthly).toFixed(2)}. The submitted ${d.rate_basis} rate is outside the allowed range.`);
  }
  const prev = await selectOne("SELECT new_amount FROM salary_history WHERE employee_id = ? AND verification_status <> 'rejected' AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1", [emp.id, d.effective_date], trx);
  // HR has already approved it, so it is recorded as verified; the version in force on a period's end date is the one paid
  await exec(
    `INSERT INTO salary_history (employee_id, previous_amount, new_amount, rate_basis, pay_frequency, effective_date, reason, verification_status)
     VALUES (?,?,?,?,?,?,?, 'verified')`,
    [emp.id, prev?.new_amount ?? null, amount, d.rate_basis, freq, d.effective_date, `Approved in HR${d.approval_reference ? ` (${str(d.approval_reference, 80)})` : ""}${d.compensation_version_id ? ` · version ${str(d.compensation_version_id, 40)}` : ""}`], trx);
  await exec(
    `UPDATE employees SET basic_salary = IF(? <= CURDATE(), ?, basic_salary), rate_basis = IF(? <= CURDATE(), ?, rate_basis), pay_frequency = ?, hr_synced_at = NOW(), hr_event_id = ? WHERE id = ?`,
    [d.effective_date, amount, d.effective_date, d.rate_basis, freq, str(e.event_id, 64), emp.id], trx);
  // The HR allowance list is the complete approved package. End every earlier
  // HR allowance first, then insert the lines HR approved for this version.
  await exec(
    `UPDATE employee_pay_items
        SET effective_to = DATE_SUB(?, INTERVAL 1 DAY),
            status = IF(effective_from >= ?, 'ended', status)
      WHERE employee_id = ?
        AND description LIKE 'HR:%'
        AND (effective_to IS NULL OR effective_to >= ?)`,
    [d.effective_date, d.effective_date, emp.id, d.effective_date], trx);
  for (const a of Array.isArray(d.allowances) ? d.allowances : []) {
    const comp = await selectOne("SELECT id FROM salary_components WHERE code = ? AND component_type = 'earning'", [str(a.code, 40)], trx);
    if (!comp) fail(`Allowance code ${a.code} is not a JVzPay earning component.`);
    await exec("INSERT INTO employee_pay_items (employee_id, component_id, description, amount, effective_from, status, decided_at) VALUES (?,?,?,?,?, 'approved', NOW())",
      [emp.id, comp.id, `HR: approved allowance${d.approval_reference ? ` (${str(d.approval_reference, 80)})` : ""}`, money(a.amount, `allowance ${a.code}`), d.effective_date], trx);
  }
  return `salary of ${emp.employee_no} from ${d.effective_date}: ${amount.toFixed(2)} ${d.rate_basis}`;
}

async function department(d, e, trx) {
  need(d, ["department_code"]);
  await upsertDepartment(d.department_code, d.department_name, d.is_active !== false, trx);
  return `department ${String(d.department_code).toUpperCase()} saved`;
}

async function position(d, e, trx) {
  need(d, ["department_code", "position_title"]);
  const dept = await selectOne("SELECT id FROM departments WHERE code = ?", [str(d.department_code, 20).toUpperCase()], trx);
  if (!dept) fail(`Department ${d.department_code} is not known yet. Send DepartmentUpserted first.`);
  await upsertPosition(dept.id, d.position_title, d.is_active !== false, trx);
  return `position ${d.position_title} saved`;
}

// handlers for CRM, Inventory and request decisions are registered by their own modules (see registerHandlers)
export const HANDLERS = {
  johnvivz_hr: {
    EmployeeCreated: employeeUpsert,
    EmployeeUpdated: employeeUpsert,
    EmployeeStatusChanged: employeeStatus,
    EmployeeCompensationApproved: compensation,
    DepartmentUpserted: department,
    PositionUpserted: position,
  },
  johnvivz_crm: {},
  johnvivz_inventory: {},
};
export function registerHandlers(source, map) { Object.assign(HANDLERS[source], map); }
export { EventError, fail as eventFail, need as eventNeed, money as eventMoney, isDate as eventIsDate, str as eventStr };

// ---- outbound events ---------------------------------------------------------------------------------------------------------
/** Queue an event for another application. Call inside the business transaction so it is sent only if that commits. */
export async function enqueue(target, eventType, entityId, data, trx = null, correlationId = null) {
  const eventId = crypto.randomUUID();
  const envelope = {
    event_id: eventId, event_type: eventType, schema_version: 1, source: "johnvivz_accounting", occurred_at: new Date().toISOString(),
    entity_id: entityId != null ? String(entityId) : null, correlation_id: correlationId || crypto.randomUUID(), idempotency_key: `${eventType}:${entityId}:${eventId}`, data,
  };
  await exec("INSERT INTO integration_outbox (event_id, target, event_type, entity_id, correlation_id, payload, next_attempt_at) VALUES (?,?,?,?,?,?, NOW())",
    [eventId, target, eventType, envelope.entity_id, envelope.correlation_id, JSON.stringify(envelope)], trx);
  return eventId;
}

export const targetConfig = (target) => {
  const p = TARGET_ENV[target];
  const url = (process.env[`${p}_URL`] || "").replace(/\/+$/, "");
  return { url, token: process.env[`${p}_TOKEN`] || "", connected: !!url };
};

/** Send due events. Unconfigured targets are marked not_connected and picked up once their URL is set. */
export async function deliverDue(limit = 25) {
  const due = await select("SELECT * FROM integration_outbox WHERE status IN ('pending','not_connected') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY id LIMIT ?", [limit]);
  let sent = 0;
  for (const o of due) {
    const cfg = targetConfig(o.target);
    if (!cfg.connected) {
      if (o.status !== "not_connected") {
        await exec("UPDATE integration_outbox SET status = 'not_connected', next_attempt_at = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?", [o.id]);
        await exec("INSERT INTO integration_logs (direction, outbox_id, outcome, message) VALUES ('out', ?, 'not_connected', ?)", [o.id, `${o.target.toUpperCase()} address not set`]);
      } else await exec("UPDATE integration_outbox SET next_attempt_at = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?", [o.id]);
      continue;
    }
    try {
      const res = await fetch(`${cfg.url}/api/v1/events`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
        body: typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload), signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        await exec("UPDATE integration_outbox SET status = 'sent', attempts = attempts + 1, sent_at = NOW(), last_error = NULL WHERE id = ?", [o.id]);
        await exec("INSERT INTO integration_logs (direction, outbox_id, outcome, message) VALUES ('out', ?, 'sent', ?)", [o.id, `HTTP ${res.status}`]);
        sent++;
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      const attempts = o.attempts + 1;
      const final = attempts >= 10;
      // back off: 1, 2, 4 … minutes, at most an hour between tries
      await exec(`UPDATE integration_outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?`,
        [final ? "failed" : "pending", attempts, String(err.message).slice(0, 500), Math.min(60, 2 ** (attempts - 1)), o.id]);
      await exec("INSERT INTO integration_logs (direction, outbox_id, outcome, message) VALUES ('out', ?, ?, ?)", [o.id, final ? "failed" : "retry", String(err.message).slice(0, 500)]);
    }
  }
  return { due: due.length, sent };
}

export async function retryOutbox(req, id) {
  const o = await selectOne("SELECT id, status FROM integration_outbox WHERE id = ?", [id]);
  if (!o) throw notFound("Event not found.");
  if (o.status === "sent") throw badRequest("This event was already delivered.");
  await exec("UPDATE integration_outbox SET status = 'pending', next_attempt_at = NOW() WHERE id = ?", [id]);
  await audit(req, { action: "integration_event_retried", module: "integration", recordType: "integration_outbox", recordId: id });
  return deliverDue(5);
}

// ---- monitoring ----------------------------------------------------------------------------------------------------------------
export async function integrationOverview({ status = "", direction = "in" } = {}) {
  const [inCounts, outCounts, clients, lastHr] = await Promise.all([
    select("SELECT status, COUNT(*) AS n FROM integration_inbox GROUP BY status"),
    select("SELECT status, COUNT(*) AS n FROM integration_outbox GROUP BY status"),
    listClients(),
    scalar("SELECT MAX(hr_synced_at) FROM employees"),
  ]);
  const inbox = direction === "in"
    ? await select(`SELECT id, event_id, source, event_type, entity_id, correlation_id, status, error, attempts, result_ref, received_at, processed_at FROM integration_inbox ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 100`, status ? [status] : [])
    : [];
  const outbox = direction === "out"
    ? await select(`SELECT id, event_id, target, event_type, entity_id, correlation_id, status, last_error, attempts, created_at, sent_at FROM integration_outbox ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 100`, status ? [status] : [])
    : [];
  const count = (rows, s) => Number(rows.find((r) => r.status === s)?.n || 0);
  return {
    counts: {
      processed: count(inCounts, "processed"), failedIn: count(inCounts, "failed"),
      sent: count(outCounts, "sent"), pendingOut: count(outCounts, "pending"), notConnected: count(outCounts, "not_connected"), failedOut: count(outCounts, "failed"),
    },
    targets: ["hr", "crm", "inventory"].map((t) => ({ target: t, label: t === "hr" ? "HR" : t === "crm" ? "CRM" : "Inventory", connected: targetConfig(t).connected })),
    clients, inbox, outbox, lastHrSync: lastHr,
  };
}

/** Employees whose HR snapshot is missing: payroll must not run for them until HR has sent their record. */
export async function hrReadiness(employeeIds = null, trx = null) {
  const rows = await select(
    `SELECT id, employee_no, first_name, last_name FROM employees
      WHERE deleted_at IS NULL AND employment_status IN ('active','on_leave') AND hr_employee_id IS NULL
        ${employeeIds ? "AND id IN (?)" : ""}`, employeeIds ? [employeeIds] : [], trx);
  return rows;
}
