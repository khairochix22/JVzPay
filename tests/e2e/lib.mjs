// Shared helpers for the phase smoke tests.
export const root = new URL("../../", import.meta.url).href;
export const db = await import(root + "lib/db.js");
const results = [];
// After a long pause a kept-alive connection may already be closed by the server. Browsers retry this, so the test client does too.
async function fetchOnceMore(url, options) {
  try { return await fetch(url, options); } catch (e) {
    if (!["ECONNRESET", "UND_ERR_SOCKET"].includes(e.cause?.code)) throw e;
    return fetch(url, options);
  }
}
export const check = (name, cond, extra = "") => results.push([cond ? "PASS" : "FAIL", name, extra]);
export function report() {
  for (const [s, n, e] of results) console.log(`${s}  ${n}${s === "FAIL" && e ? "  → " + String(e).slice(0, 400) : ""}`);
  console.log(`\n${results.filter((x) => x[0] === "PASS").length}/${results.length} passed`);
}
export const errText = (r) => (r.text.match(/(alert--error[\s\S]{0,300}?<\/div>)|(field__error[^<]*<)/g) || []).join(" | ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

export class Client {
  constructor(base) { this.base = base; this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); } }
  async req(method, path, body, headers = {}) {
    const r = await fetchOnceMore(this.base + path, { method, headers: { cookie: this.cookie(), ...headers }, body, redirect: "manual" });
    this.store(r);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, loc: r.headers.get("location"), type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), buf, text: buf.toString("utf8") };
  }
  get(p) { return this.req("GET", p); }
  // `data` may contain arrays (repeated keys) and nested objects rows[1][status]
  post(p, data) {
    const params = new URLSearchParams();
    const add = (k, v) => { if (v === undefined || v === null) return; if (Array.isArray(v)) v.forEach((x) => params.append(k, x)); else if (typeof v === "object") Object.entries(v).forEach(([kk, vv]) => add(`${k}[${kk}]`, vv)); else params.append(k, v); };
    Object.entries(data).forEach(([k, v]) => add(k, v));
    return this.req("POST", p, params, { "content-type": "application/x-www-form-urlencoded" });
  }
  multipart(p, data, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(data)) fd.append(k, v);
    if (file) fd.append("attachment", new Blob([file.bytes], { type: file.type }), file.name);
    return this.req("POST", p, fd);
  }
  async csrf(p = "/dashboard") { const r = await this.get(p); return /name="_csrf" value="([a-f0-9]+)"/.exec(r.text)?.[1]; }
  async login(email, password) { const t = await this.csrf("/login"); return this.post("/login", { _csrf: t, email, password }); }
  // GET the page for a fresh token, then POST to `p` (or `target`)
  async submit(page, target, data) { const t = await this.csrf(page); return this.post(target, { _csrf: t, ...data }); }
}

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const daysFrom = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
// most recent past weekday that is not Sunday (the default rest day), n workdays back
export function pastWorkday(n = 1) { const d = new Date(); let k = 0; while (k < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0) k++; } return iso(d); }

// ---- HR stand-in: employee records and their logins arrive from the HR system, which is not connected yet.
// Tests load the same records an HR sync would, straight into the local copy.
export async function hrFixture() {
  const { selectOne, exec } = db;
  const { nextValue } = await import(root + "lib/sequence.js");
  const { encrypt } = await import(root + "lib/crypto.js");
  const bcrypt = (await import("bcrypt")).default;
  const admin = await selectOne("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'accounting_supervisor' ORDER BY u.id LIMIT 1");
  const adminDept = await selectOne("SELECT id FROM departments WHERE code = 'ADMIN'");
  const acctDept = await selectOne("SELECT id FROM departments WHERE code = 'PAYROLL_ACCOUNTING'");
  const position = async (title) => (await selectOne("SELECT id FROM positions WHERE title = ?", [title])).id;
  const { insertId: cash } = await exec("INSERT INTO departments (code, name, description) VALUES ('CASH', 'Cashiering', 'Front-of-store cashiers')");
  const { insertId: cashier } = await exec("INSERT INTO positions (department_id, title) VALUES (?, 'Cashier')", [cash]);

  async function employee(e) {
    const no = "JV-" + String(await nextValue("employee_no")).padStart(4, "0");
    const { insertId: id } = await exec(
      `INSERT INTO employees (employee_no, first_name, middle_name, last_name, gender, birth_date, email, phone, barangay, municipality, province,
         department_id, position_id, employment_type, employment_status, date_hired, rate_basis, basic_salary, pay_frequency, sss_no_enc, tin_enc, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,'Bongabong','Oriental Mindoro',?,?,'regular','active',?,?,?,'semi_monthly',?,?,?,?)`,
      [no, e.first, e.middle ?? null, e.last, e.gender ?? null, e.birth ?? null, e.email ?? null, e.phone ?? null, e.barangay ?? null, e.dept, e.pos,
        e.hired, e.basis, e.salary, e.sss ? encrypt(e.sss) : null, e.tin ? encrypt(e.tin) : null, admin.id, admin.id]);
    await exec("INSERT INTO employment_history (employee_id, change_type, to_department_id, to_position_id, to_status, to_type, effective_date, remarks, recorded_by) VALUES (?,'hired',?,?,'active','regular',?,'Initial hire record',?)",
      [id, e.dept, e.pos, e.hired, admin.id]);
    await exec("INSERT INTO salary_history (employee_id, previous_amount, new_amount, rate_basis, pay_frequency, effective_date, reason, verification_status, recorded_by) VALUES (?,NULL,?,?,'semi_monthly',?,'Starting salary','verified',?)",
      [id, e.startSalary ?? e.salary, e.basis, e.hired, admin.id]);
    // as HR would send it: the HR employee id and the moment of the last sync
    await exec("UPDATE employees SET hr_employee_id = ?, hr_synced_at = NOW() WHERE id = ?", [`HR-${no}`, id]);
    return id;
  }
  const maria = await employee({ first: "Maria", middle: "Santos", last: "Dela Cruz", gender: "female", birth: "1998-04-12", email: "maria@example.com", phone: "09179999999", barangay: "Poblacion",
    // Maria works in Payroll/Accounting, so her requests are decided in JVzPay (stage 18 covers the other departments)
    dept: acctDept.id, pos: await position("Employee (ESS)"), hired: "2025-03-01", basis: "daily", salary: "560.00", startSalary: "520.00", sss: "34-1234567-8", tin: "123-456-789-000" });
  // a raise HR sent over, still waiting for the Accounting Supervisor to verify it
  await exec("INSERT INTO salary_history (employee_id, previous_amount, new_amount, rate_basis, pay_frequency, effective_date, reason, verification_status, recorded_by) VALUES (?, '520.00', '560.00', 'daily', 'semi_monthly', CURDATE(), 'Annual increase', 'pending', ?)", [maria, admin.id]);
  const paolo = await employee({ first: "Paolo", last: "Reyes", dept: acctDept.id, pos: await position("Payroll Staff"), hired: "2024-06-01", basis: "monthly", salary: "18000.00" });
  const grace = await employee({ first: "Grace", last: "Villanueva", dept: acctDept.id, pos: await position("Accounting Supervisor"), hired: "2024-06-01", basis: "monthly", salary: "18000.00" });

  // Carla is Accounting Staff with no employee link, like an account approved from /register
  const temp = { maria: "TempMaria2026x", paolo: "TempPaolo2026x", grace: "TempGrace2026x", carla: "TempCarla2026x" };
  for (const [key, email, name, role, id] of [["maria", "maria@johnvivz.local", "Maria Dela Cruz", "employee", maria], ["paolo", "paolo@johnvivz.local", "Paolo Reyes", "payroll_staff", paolo], ["grace", "grace@johnvivz.local", "Grace Villanueva", "accounting_supervisor", grace], ["carla", "carla@johnvivz.local", "Carla Mendoza", "accounting_staff", null]]) {
    await exec("INSERT INTO users (employee_id, role_id, email, full_name, password_hash, must_change_password, created_by) VALUES (?, (SELECT id FROM roles WHERE code = ?), ?, ?, ?, 1, ?)",
      [id, role, email, name, await bcrypt.hash(temp[key], 12), admin.id]);
  }
  return { temp, ids: { maria, paolo, grace }, cash, cashier };
}
