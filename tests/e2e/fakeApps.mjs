// Fake HR and Inventory applications for the end-to-end tests, written from the team decisions of 2026-11-16:
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
  const s = { departments: [], employees: new Map(), compensation: [], down: false, calls: [], pageSize: 2 };
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
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
    const paged = (all) => {
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      return { items: all.slice((page - 1) * s.pageSize, page * s.pageSize), page, total_pages: Math.max(1, Math.ceil(all.length / s.pageSize)) };
    };
    if (req.method === "GET" && path === "/departments") return send(res, 200, { items: s.departments, page: 1, total_pages: 1 });
    if (req.method === "GET" && path === "/employees") return send(res, 200, paged([...s.employees.values()]));
    if (req.method === "GET" && path?.startsWith("/employees/")) {
      const id = decodeURIComponent(path.slice(11));
      const e = s.employees.get(id) || [...s.employees.values()].find((x) => x.employee_id.toLowerCase() === id.toLowerCase());
      return e ? send(res, 200, { data: e }) : send(res, 404, { error: "not_found" });
    }
    const comp = /^\/payroll\/employees\/([^/]+)\/compensation$/.exec(path || "");
    if (req.method === "GET" && comp) {
      const c = s.compensation.find((x) => x.employee_id.toLowerCase() === decodeURIComponent(comp[1]).toLowerCase());
      return c ? send(res, 200, { data: c }) : send(res, 404, { error: "not_found" });
    }
    if (req.method === "POST" && path === "/employees/verify") {
      const e = [...s.employees.values()].find((x) => x.employee_id.toLowerCase() === String(body.employee_id || "").toLowerCase());
      if (!e) return send(res, 200, { match: false, eligible: false, mismatches: ["employee_id"], employee: null });
      const dept = s.departments.find((d) => d.id === e.department_id) || {};
      const mismatches = [];
      const typed = norm(body.full_name);
      if (!typed.split(" ").includes(norm(e.first_name).split(" ")[0]) || !typed.includes(norm(e.last_name))) mismatches.push("full_name");
      if (norm(body.email) !== norm(e.email)) mismatches.push("email");
      if (![norm(dept.name), norm(dept.code)].includes(norm(body.department)) && norm(body.department_code) !== norm(dept.code)) mismatches.push("department");
      if (norm(body.position) !== norm(e.position?.title)) mismatches.push("position");
      if (norm(body.verification_reference) !== norm(e.employee_code)) mismatches.push({ field: "verification_reference", hr_value: e.employee_code }); // a value JVzPay must never show
      const match = mismatches.length === 0;
      return send(res, 200, { match, eligible: match && ["active", "on leave"].includes(norm(e.employment_status)), mismatches, employee: match ? { employee_id: e.employee_id } : null });
    }
    return send(res, 404, { error: "not_found" });
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
