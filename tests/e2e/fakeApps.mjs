// Fake HR and Inventory applications for the end-to-end tests. HR answers in the shape of HR's LIVE API (2026-11-17):
//   HR (pull-only, Bearer key): GET /api/integration/v1/departments, /employees (paged), /employees/:identifier,
//     /payroll/employees/:identifier/compensation; POST /employees/verify → {match, eligible, mismatches, employee}
//   Inventory (Bearer token): GET /api/integration/v1/accounting/outbox, POST /accounting/outbox/:eventId/ack
// They prove JVzPay does what the decisions say, not that the real HR and Inventory do (their JSON shapes were not
// available). Test stages control them through /__test/... endpoints (no auth: test only, bound to 127.0.0.1).
import http from "node:http";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const PREFIX = "/api/integration/v1";

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

function hrApp(token) {
  // Test stages give simple records: {employee_id (JV number), first_name, last_name, email, department_id, position:{title},
  // employment_status, hire_date, employee_code, supervisor_employee_id (JV), listed (false = a new hire HR does not list
  // yet)}. The fake answers in the SHAPE OF HR'S LIVE API (read 2026-11-17): internal employee_id + permanent_employee_id,
  // department object, position text, status, reporting_supervisor_id (internal), {success, data:{items, …}} lists.
  const s = { departments: [], employees: new Map(), internal: new Map(), nextId: 100, compensation: [], down: false, calls: [], pageSize: 2 };
  const internalOf = (jv) => { if (!s.internal.has(jv)) s.internal.set(jv, s.nextId++); return s.internal.get(jv); };
  const dept = (id) => s.departments.find((d) => d.id === id) || {};
  const real = (e) => ({
    employee_id: internalOf(e.employee_id), permanent_employee_id: e.employee_id, employee_code: e.employee_code ?? null,
    first_name: e.first_name, last_name: e.last_name, full_name: `${e.first_name} ${e.last_name}`, email: e.email, phone_number: null,
    department: { department_id: e.department_id, department_code: dept(e.department_id).code, department_name: dept(e.department_id).name },
    position: e.position?.title ?? null, employment_type: null, work_schedule: null,
    reporting_supervisor_id: e.supervisor_employee_id ? internalOf(e.supervisor_employee_id) : null, hire_date: e.hire_date, status: e.employment_status,
  });
  // HR also lists its own system accounts, which have no JV Employee ID
  const systemAccount = { employee_id: 1, permanent_employee_id: null, employee_code: null, first_name: "System", last_name: "Account", full_name: "System Account", email: "system@hr.local", phone_number: null,
    department: { department_id: 1, department_code: "HR", department_name: "HR" }, position: "System account", employment_type: null, work_schedule: null, reporting_supervisor_id: null, hire_date: "2000-01-01", status: "Active" };
  const ok = (data) => ({ success: true, data, message: "OK", errors: {} });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = await readBody(req);
    if (url.pathname.startsWith("/__test/")) {
      const what = url.pathname.slice(8);
      if (what === "employees") { for (const e of [].concat(body)) s.employees.set(e.employee_id, { ...(s.employees.get(e.employee_id) || {}), ...e }); return send(res, 200, { ok: true }); }
      if (what === "departments") { s.departments = body; return send(res, 200, { ok: true }); }
      if (what === "compensation") { for (const c of [].concat(body)) { s.compensation = s.compensation.filter((x) => x.employee_id !== c.employee_id); s.compensation.push(c); } return send(res, 200, { ok: true }); }
      if (what === "down") { s.down = !!body.down; return send(res, 200, { ok: true }); }
      if (what === "calls") return send(res, 200, s.calls);
      return send(res, 404, {});
    }
    s.calls.push({ method: req.method, path: url.pathname + url.search, authorization: req.headers.authorization ? "Bearer ***" : null, ok: req.headers.authorization === `Bearer ${token}` });
    if (s.down) return req.socket.destroy(); // "cannot be reached"
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { success: false, data: null, message: "Unauthorized", errors: {} });
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
    const listed = () => [systemAccount, ...[...s.employees.values()].filter((e) => e.listed !== false).map(real)];
    const byInternal = (id) => listed().find((e) => String(e.employee_id) === String(id));
    if (req.method === "GET" && path === "/health") return send(res, 200, { status: "ok", app: "johnvivz_hr" });
    if (req.method === "GET" && path === "/departments") return send(res, 200, ok(s.departments.map((d) => ({ department_id: d.id, department_code: d.code, department_name: d.name, description: null, active_headcount: 0 }))));
    if (req.method === "GET" && path === "/employees") {
      const all = listed(), page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      return send(res, 200, ok({ items: all.slice((page - 1) * s.pageSize, page * s.pageSize), page, page_size: s.pageSize, total: all.length, total_pages: Math.max(1, Math.ceil(all.length / s.pageSize)) }));
    }
    let m = /^\/employees\/([^/]+)$/.exec(path || "");
    if (req.method === "GET" && m) { const e = byInternal(decodeURIComponent(m[1])); return e ? send(res, 200, ok(e)) : send(res, 404, { success: false, data: null, message: "Not found", errors: {} }); }
    m = /^\/payroll\/employees\/([^/]+)\/compensation$/.exec(path || "");
    if (req.method === "GET" && m) {
      const e = byInternal(decodeURIComponent(m[1]));
      if (!e) return send(res, 404, { success: false, data: null, message: "Not found", errors: {} });
      const c = s.compensation.find((x) => x.employee_id === e.permanent_employee_id);
      return send(res, 200, ok({ ...e, compensation: c ? { as_of: c.effective_date, compensation_version_id: c.version_id ?? null, basic_salary: Number(c.basic_salary), compensation_basis: c.rate_basis || "monthly", components: [], fixed_monthly_total: Number(c.basic_salary) } : null }));
    }
    if (req.method === "POST" && path === "/employees/verify") {
      const errors = {};
      if (!body.employee_code) errors.employee_code = "Required.";
      else if (!body.verification_reference) errors.verification_reference = "Required.";
      if (Object.keys(errors).length) return send(res, 400, { success: false, data: null, message: "Check the listed fields.", errors });
      const e = [...s.employees.values()].find((x) => x.employee_id.toLowerCase() === String(body.employee_id || "").toLowerCase());
      if (!e) return send(res, 404, { match: false });
      const d = dept(e.department_id);
      const mismatches = [];
      const typed = norm(body.full_name);
      if (!typed.split(" ").includes(norm(e.first_name).split(" ")[0]) || !typed.includes(norm(e.last_name))) mismatches.push("full_name");
      if (norm(body.email) !== norm(e.email)) mismatches.push("email");
      if (![norm(d.name), norm(d.code)].includes(norm(body.department)) && norm(body.department_code) !== norm(d.code)) mismatches.push("department");
      if (norm(body.position) !== norm(e.position?.title)) mismatches.push("position");
      if (norm(body.employee_code) !== norm(e.employee_code)) mismatches.push("employee_code");
      const match = mismatches.length === 0;
      return send(res, 200, { match, eligible: match && ["active", "on leave"].includes(norm(e.employment_status)), mismatches, employee: match ? real(e) : null });
    }
    return send(res, 404, { success: false, data: null, message: "Not found", errors: {} });
  });
  return { server, state: s };
}

function inventoryApp(token) {
  const s = { outbox: [], acked: [], calls: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = await readBody(req);
    if (url.pathname === "/__test/outbox") { if (req.method === "POST") { s.outbox.push(...[].concat(body)); return send(res, 200, { ok: true }); } return send(res, 200, s); }
    s.calls.push({ method: req.method, path: url.pathname, ok: req.headers.authorization === `Bearer ${token}` });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && url.pathname === `${PREFIX}/accounting/outbox`) return send(res, 200, { events: s.outbox.filter((e) => !s.acked.includes(e.event_id ?? e.id)).slice(0, Number(url.searchParams.get("limit")) || 100) });
    const m = /^\/api\/integration\/v1\/accounting\/outbox\/([^/]+)\/ack$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const id = decodeURIComponent(m[1]);
      if (!s.outbox.some((e) => (e.event_id ?? e.id) === id)) return send(res, 404, { error: "not_found" });
      if (!s.acked.includes(id)) s.acked.push(id);
      return send(res, 200, { status: "acknowledged", event_id: id });
    }
    return send(res, 404, { error: "not_found" });
  });
  return { server, state: s };
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

/** Starts both fakes on free local ports in THIS process. Returns their addresses and a close(). */
export async function startFakeApps({ hrToken, inventoryToken }) {
  const hr = hrApp(hrToken), inv = inventoryApp(inventoryToken);
  const [hrUrl, invUrl] = await Promise.all([listen(hr.server), listen(inv.server)]);
  return { hrUrl, invUrl, close: () => { hr.server.close(); inv.server.close(); } };
}

/**
 * Starts the fakes in a CHILD process. The e2e runner runs each stage with spawnSync, which blocks its own event loop:
 * fakes inside the runner could not answer JVzPay while a stage runs. Resolves with { hrUrl, invUrl, close }.
 */
export async function spawnFakeApps({ hrToken, inventoryToken }) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], {
    env: { ...process.env, FAKE_HR_TOKEN: hrToken, FAKE_INVENTORY_TOKEN: inventoryToken }, stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
  });
  const urls = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; const line = out.split("\n")[0]; if (out.includes("\n")) { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } } });
    child.on("exit", (code) => reject(new Error(`fake apps exited (${code})`)));
  });
  return { ...urls, close: () => child.kill() };
}

// run directly: start the fakes and print their addresses (used by spawnFakeApps)
if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1").toLowerCase() === process.argv[1].replace(/\\/g, "/").toLowerCase()) {
  const f = await startFakeApps({ hrToken: process.env.FAKE_HR_TOKEN, inventoryToken: process.env.FAKE_INVENTORY_TOKEN });
  process.stdout.write(`${JSON.stringify({ hrUrl: f.hrUrl, invUrl: f.invUrl })}\n`);
}
