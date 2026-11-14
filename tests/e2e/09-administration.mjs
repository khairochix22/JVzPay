// Phase 9 end-to-end: announcements, settings, roles, security monitor, backups, dashboards. Runs after smoke 3–7.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { Client, check, report, db, errText, pastWorkday } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;
const maria = new Client(base), paolo = new Client(base), grace = new Client(base), admin = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await paolo.login("paolo@johnvivz.local", "Welcome2026ok");
await grace.login("grace@johnvivz.local", "Welcome2026ok");
await admin.login("admin@johnvivz.local", "Ledger2026xyz");

// ---- access
for (const p of ["/settings", "/settings/roles", "/settings/announcements", "/settings/backup", "/settings/security"]) {
  check(`staff blocked from ${p} (403)`, (await paolo.get(p)).status === 403);
  check(`employee blocked from ${p} (403)`, (await maria.get(p)).status === 403);
  check(`admin can open ${p}`, (await admin.get(p)).status === 200);
}

// ---- announcements
let t = await admin.csrf("/settings/announcements");
let r = await admin.post("/settings/announcements", { _csrf: t, title: "", body: "x", audience: "all" });
check("announcement needs a title", !(await selectOne("SELECT id FROM announcements")));
await admin.post("/settings/announcements", { _csrf: t, title: "Payroll cut-off moved", body: "Cut-off is now every 14th.", audience: "all" });
await admin.post("/settings/announcements", { _csrf: t, title: "Staff meeting", body: "Friday 3PM.", audience: "staff" });
r = await maria.get("/dashboard"); check("employee sees 'all' announcement, not staff one", r.text.includes("Payroll cut-off moved") && !r.text.includes("Staff meeting"));
r = await paolo.get("/dashboard"); check("staff sees both announcements", r.text.includes("Payroll cut-off moved") && r.text.includes("Staff meeting"));
r = await maria.get("/notifications"); check("announcement sent as notification", r.text.includes("Payroll cut-off moved"));
const ann = await selectOne("SELECT id FROM announcements WHERE title='Staff meeting'");
await admin.post(`/settings/announcements/${ann.id}/withdraw`, { _csrf: t });
r = await paolo.get("/dashboard");
const annPanel = (/<h2>Announcements<\/h2>[\s\S]*?<\/section>/.exec(r.text) || [""])[0];
check("withdrawn announcement leaves the panel", annPanel.includes("Payroll cut-off moved") && !annPanel.includes("Staff meeting"));
check("its notification stays in the history", r.text.includes("Staff meeting"));

// ---- settings
r = await admin.get("/settings"); check("settings grouped", r.text.includes("Attendance") && r.text.includes("Payroll") && r.text.includes("Company"));
const all = await select("SELECT setting_key, setting_value, value_type FROM system_settings");
const form = Object.fromEntries(all.filter((s) => s.value_type !== "boolean" || s.setting_value === "1").map((s) => [s.setting_key.replace(/\./g, "__"), s.setting_value]));
t = await admin.csrf("/settings");
r = await admin.post("/settings", { _csrf: t, ...form, attendance__grace_minutes: "abc" }); r = await admin.get("/settings");
check("invalid number refused", r.text.includes("enter a number") && (await selectOne("SELECT setting_value v FROM system_settings WHERE setting_key='attendance.grace_minutes'")).v === "10");
await admin.post("/settings", { _csrf: t, ...form, attendance__grace_minutes: "15" });
check("setting saved", (await selectOne("SELECT setting_value v FROM system_settings WHERE setting_key='attendance.grace_minutes'")).v === "15");
check("settings change audited", !!(await selectOne("SELECT id FROM audit_logs WHERE action='settings_updated'")));
await admin.post("/settings", { _csrf: t, ...form });

// ---- roles & permissions
const roles = await select("SELECT * FROM roles"), perms = await select("SELECT * FROM permissions");
const grants = await select("SELECT * FROM role_permissions");
const body = (mut = () => {}) => { const b = {}; for (const r2 of roles) b[`r${r2.id}`] = {}; for (const g of grants) b[`r${g.role_id}`][`p${g.permission_id}`] = "1"; mut(b); return b; };
const P = (c) => perms.find((x) => x.code === c).id, R = (c) => roles.find((x) => x.code === c).id;
r = await admin.get("/settings/roles"); check("permission matrix renders", r.text.includes("payroll.approve") && r.text.includes("Accounting Supervisor"));
t = await admin.csrf("/settings/roles");
await admin.post("/settings/roles", { _csrf: t, ...body((b) => { delete b[`r${R("accounting_supervisor")}`][`p${P("roles.manage")}`]; }) });
r = await admin.get("/settings/roles"); check("super admin cannot lose roles.manage", r.text.includes("must keep"));
await admin.post("/settings/roles", { _csrf: t, ...body((b) => { b[`r${R("payroll_staff")}`][`p${P("payroll.approve")}`] = "1"; }) });
r = await admin.get("/settings/roles"); check("conflicting grant refused (prepare + approve)", r.text.includes("approve their own work"));
await admin.post("/settings/roles", { _csrf: t, ...body((b) => { b[`r${R("employee")}`][`p${P("analytics.view")}`] = "1"; }) });
r = await maria.get("/analytics"); check("granting a permission takes effect immediately", r.status === 200);
await admin.post("/settings/roles", { _csrf: t, ...body() });
r = await maria.get("/analytics"); check("revoking takes effect immediately", r.status === 403);

// ---- security monitor
const bad = new Client(base);
await bad.login("nobody@example.com", "wrongpassword1");
r = await admin.get("/settings/security"); check("security monitor shows failed sign-ins", r.text.includes("nobody@example.com") && r.text.includes("Sensitive actions"));
await sequelize.query("INSERT INTO audit_logs (user_name, user_role, action, module, record_type, record_id, remarks) SELECT user_name, user_role, action, module, record_type, record_id, remarks FROM audit_logs WHERE action = 'bank_number_revealed' LIMIT 1");
r = await admin.get("/settings/security"); check("a bank number reveal appears as sensitive", r.text.includes("Bank Number Revealed"));
check("full audit log is one click away", r.text.includes('href="/audit"'));

// ---- backups
t = await admin.csrf("/settings/backup");
r = await admin.post("/settings/backup", { _csrf: t }); r = await admin.get("/settings/backup");
const m = /jvzpay-[\d-]+\.sql\.gz/.exec(r.text);
check("backup created", !!m, errText(r));
const dl = await admin.get(`/settings/backup/${m[0]}/download`);
const sql = zlib.gunzipSync(dl.buf).toString("utf8");
check("backup is a valid dump with tables and triggers", sql.includes("CREATE TABLE `payroll_records`") && sql.includes("trg_pr_bu") && sql.includes("INSERT INTO `employees`"));
check("backup holds no plaintext bank number", !sql.includes("001122334455") && !sql.includes("1234567890"));
r = await admin.get("/settings/backup/..%2F..%2F.env/download"); check("path traversal refused", r.status === 400 || r.status === 404, String(r.status));
await admin.post(`/settings/backup/${m[0]}/delete`, { _csrf: t });
check("backup deleted", !fs.existsSync(path.join(process.env.BACKUP_DIR, m[0])));
r = await admin.post("/settings/backup/cleanup", { _csrf: t }); check("cleanup runs", r.status === 302);

// ---- values rendered into forms and meters
const encodeDay = pastWorkday(1);
r = await paolo.get(`/attendance/encode?date=${encodeDay}`);
check("attendance form keeps the chosen date", r.text.includes(`name="date" value="${encodeDay}"`) && !r.text.includes('value="—"'), errText(r));
r = await maria.get("/dashboard");
const widths = [...r.text.matchAll(/class="meter"[^>]*><span style="width:([^"]*)"/g)].map((x) => x[1]);
check("leave meters use real percentages", widths.length > 0 && widths.every((w) => /^\d+%$/.test(w)), widths.join(","));

// ---- dashboards complete for each role
r = await admin.get("/dashboard"); check("admin dashboard panels", ["Pending approvals", "Recent payroll batches", "Notifications", "Quick actions", "Recent activity"].every((x) => r.text.includes(x)), errText(r));
r = await grace.get("/dashboard"); check("supervisor dashboard panels", ["Financial performance", "Cash flow", "Payroll expense", "Recent payroll batches"].every((x) => r.text.includes(x)));
r = await paolo.get("/dashboard"); check("staff dashboard panels", ["Pending approvals", "Recent payroll batches", "Quick actions"].every((x) => r.text.includes(x)));
r = await maria.get("/dashboard"); check("employee dashboard panels", ["Recent payslips", "Quick actions", "Recent notifications", "Leave credits"].every((x) => r.text.includes(x)));
for (const c of [admin, grace, paolo, maria]) { r = await c.get("/dashboard"); check("no 'pending module' labels remain", !/module pending|later phase/i.test(r.text)); }
// ---- a browser follows a redirect as soon as the headers arrive, so the session must already be saved by then
let flashesSeen = 0;
const raceToken = await admin.csrf("/settings/announcements");
for (let i = 0; i < 15; i++) {
  const res = await fetch(`${base}/settings/announcements`, { method: "POST", redirect: "manual", headers: { cookie: admin.cookie(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ _csrf: raceToken, title: "", body: "x", audience: "all" }) });
  const next = await admin.get(res.headers.get("location")); // the POST's body is deliberately not read first
  if (next.text.includes("alert--error")) flashesSeen++;
}
check("messages survive an immediate redirect", flashesSeen === 15, `${flashesSeen}/15`);

// ---- specification audit: filters, table tools, masks, privacy notice
r = await admin.get("/analytics?year=2026");
check("analytics filters by year", r.status === 200 && r.text.includes('<option value="2026" selected>') && r.text.includes("Operating expenses by account"));
r = await admin.get("/analytics?month=2026-10");
check("analytics filters by month", r.status === 200 && r.text.includes('name="month" value="2026-10"'));
r = await new Client(base).get("/privacy");
check("privacy notice is public", r.status === 200 && r.text.includes("Republic Act No. 10173"));
r = await new Client(base).get("/login");
check("sign-in page links the privacy notice", r.text.includes('href="/privacy"'));
r = await admin.get("/audit?sort=user&dir=asc");
check("audit log sorts by user", r.status === 200 && r.text.includes('aria-sort="ascending"'));
r = await admin.get("/payroll");
const someRows = (await select("SELECT COUNT(*) n FROM payroll_periods WHERE label LIKE '%TEST-REL%'"))[0].n;
check("the Payroll tab lists the periods", r.status === 200 && Number(someRows) > 0 && r.text.includes("TEST-REL"));
r = await admin.get("/payroll?show=special");
check("the special-period filter leaves the fixed kinsenas and katapusan out", r.status === 200 && !r.text.includes("(kinsenas)") && !r.text.includes("(katapusan)"));
r = await admin.get("/accounting/accounts");
check("short lists get table tools", r.text.includes("data-table-tools") && r.text.includes("/js/table-tools.js"));
r = await maria.get("/my/profile");
check("phone field is masked", r.text.includes('data-mask="phone"'));
t = await admin.csrf("/settings");
await admin.post("/settings", { _csrf: t, ...form, privacy__accountable_person: "Rosa Lim", privacy__contact_email: "privacy@johnvivz.local", privacy__contact_phone: "" });
r = await new Client(base).get("/privacy");
check("privacy notice names the accountable person from Settings", r.text.includes("Rosa Lim") && r.text.includes("privacy@johnvivz.local") && r.text.includes("at least 3 years"));
check("privacy contact settings may be left blank", (await selectOne("SELECT setting_value v FROM system_settings WHERE setting_key = 'privacy.contact_phone'")).v === "");
report();
await sequelize.close();
