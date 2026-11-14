// Security controls added on 2026-11-10: lockout after 3 attempts, expiring reset links, session keep-alive and 401s,
// print logging, privacy acknowledgement, sign-in history, the sealed audit trail, daily backup and retention clean-up.
import fs from "node:fs";
import path from "node:path";
import { Client, check, report, db } from "./lib.mjs";

const base = process.argv[2];
const { select, selectOne, exec, sequelize } = db;
const root = new URL("../../", import.meta.url);
const LINK = /(https?:\/\/[^\s<"]+\/reset-password\/[A-Za-z0-9_-]+)/;

const admin = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");

// ---- health check for uptime monitors
let r = await fetch(`${base}/healthz`);
const health = await r.json();
check("health check answers", r.status === 200 && health.status === "ok" && health.database === "ok");

// ---- lockout after 3 wrong passwords
const liza = await selectOne("SELECT id FROM users WHERE email = 'liza@johnvivz.local'");
const bad = new Client(base);
for (let i = 0; i < 3; i++) await bad.login("liza@johnvivz.local", `Wrong2026x${i}`);
r = await bad.login("liza@johnvivz.local", "Ledger2026abc");
check("account locks after 3 wrong passwords", r.status === 401);
check("the lockout is recorded", !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'account_locked' AND record_id = ?", [String(liza.id)])));

// ---- one-time, expiring reset link
let t = await admin.csrf(`/users/${liza.id}/edit`);
await admin.post(`/users/${liza.id}/reset-link`, { _csrf: t });
const link = LINK.exec((await admin.get(`/users/${liza.id}/edit`)).text)?.[1];
check("reset link created and shown", !!link);
const token = link?.split("/").pop() || "";
const linkPath = link ? new URL(link).pathname : "/reset-password/none";
check("only a hash of the link is stored", !!(await selectOne("SELECT id FROM password_resets WHERE token_hash = SHA2(?, 256)", [token])) && !(await selectOne("SELECT id FROM password_resets WHERE token_hash = ?", [token])));
check("the link is not written to the audit trail", !(await selectOne("SELECT id FROM audit_logs WHERE remarks LIKE ? OR CAST(new_value AS CHAR) LIKE ?", [`%${token}%`, `%${token}%`])));
const visitor = new Client(base);
r = await visitor.get(linkPath);
check("reset page opens for the right account", r.status === 200 && r.text.includes("liza@johnvivz.local"));
let tk = await visitor.csrf(linkPath);
r = await visitor.post(linkPath, { _csrf: tk, new_password: "short", confirm_password: "short" });
check("a weak new password is refused", r.status === 422);
r = await visitor.post(linkPath, { _csrf: tk, new_password: "Reset2026abcd", confirm_password: "Reset2026abcd" });
check("new password set through the link", r.status === 302 && r.loc === "/login");
r = await new Client(base).login("liza@johnvivz.local", "Reset2026abcd");
check("the reset unlocked the account; the new password works", r.status === 302 && r.loc === "/dashboard", `${r.status} ${r.loc}`);
r = await new Client(base).login("liza@johnvivz.local", "Ledger2026abc");
check("the old password stops working", r.status === 401);
check("a used link cannot be used again", (await visitor.get(linkPath)).status === 410);
t = await admin.csrf(`/users/${liza.id}/edit`);
await admin.post(`/users/${liza.id}/reset-link`, { _csrf: t });
const link2 = LINK.exec((await admin.get(`/users/${liza.id}/edit`)).text)?.[1] || "";
await exec("UPDATE password_resets SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE token_hash = SHA2(?, 256)", [link2.split("/").pop()]);
check("an expired link is refused", link2 && (await visitor.get(new URL(link2).pathname)).status === 410);
check("a made-up link is refused", (await visitor.get("/reset-password/abcdefghijklmnopqrstuvwxyz0123456789ABCD")).status === 410);
const self = await selectOne("SELECT id FROM users WHERE email = 'admin@johnvivz.local'");
t = await admin.csrf(`/users/${self.id}/edit`);
await admin.post(`/users/${self.id}/reset-link`, { _csrf: t });
check("no reset link for your own account", (await admin.get(`/users/${self.id}/edit`)).text.includes("Use Change password"));

// ---- inactivity: keep-alive, and 401 for scripts once signed out
const maria = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
r = await maria.get("/dashboard");
check("pages carry the inactivity warning", r.text.includes("data-session") && r.text.includes("session-dialog") && r.text.includes("/js/session-timer.js"));
t = await maria.csrf("/dashboard");
r = await maria.post("/session/keepalive", { _csrf: t });
check("Stay signed in extends the session", r.status === 204);
const anon = new Client(base);
const anonToken = await anon.csrf("/login");
r = await fetch(`${base}/session/keepalive`, { method: "POST", redirect: "manual", headers: { cookie: anon.cookie(), accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ _csrf: anonToken }) });
check("signed-out scripts get 401", r.status === 401 && (await r.json()).error);
check("the sign-in page explains an inactivity sign-out", (await anon.get("/login?expired=1")).text.includes("minutes without activity"));

// ---- printing is logged
r = await maria.post("/activity/print", { _csrf: t, page: "/my/payslips/1", title: "Payslip · JVzPay" });
check("printing is recorded in the audit trail", r.status === 204 && !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'page_printed' AND module = 'payslips' AND user_name LIKE 'Maria%'")));

// ---- sign-in history
r = await admin.get("/settings/security/sign-ins?type=failed");
check("sign-in history lists failed attempts and lockouts", r.status === 200 && r.text.includes("Account Locked") && r.text.includes("Liza Manalo"));
r = await admin.get("/settings/security/sign-ins?type=login&q=maria");
check("sign-in history filters sign-ins", r.text.includes("Sign-in") && r.text.includes("Maria"));
check("employees cannot open it (403)", (await maria.get("/settings/security/sign-ins")).status === 403);

// ---- sealed audit trail
t = await admin.csrf("/settings/security");
await admin.post("/settings/security/verify-audit", { _csrf: t });
let sec = await admin.get("/settings/security");
check("the audit trail verifies", sec.text.includes("Audit trail verified"));
check("records are sealed", Number((await selectOne("SELECT COUNT(*) n FROM audit_logs WHERE seal_seq IS NOT NULL")).n) > 50);
let refused = false;
try { await exec("UPDATE audit_logs SET remarks = 'x' WHERE seal_seq = 1"); } catch { refused = true; }
check("the database refuses to edit a sealed record", refused);
refused = false;
try { await exec("UPDATE audit_logs SET seal_hash = REPEAT('0', 64) WHERE seal_seq = 1"); } catch { refused = true; }
check("a seal cannot be rewritten", refused);
const victim = await selectOne("SELECT id, remarks FROM audit_logs WHERE seal_seq = 5");
const trigger = /CREATE TRIGGER trg_audit_logs_bu[\s\S]*?END\$\$/.exec(fs.readFileSync(new URL("database/migrations/009_security_hardening.sql", root), "utf8"))[0].replace(/\$\$$/, "");
await exec("DROP TRIGGER trg_audit_logs_bu");
await exec("UPDATE audit_logs SET remarks = 'changed directly in MySQL' WHERE id = ?", [victim.id]);
t = await admin.csrf("/settings/security");
await admin.post("/settings/security/verify-audit", { _csrf: t });
sec = await admin.get("/settings/security");
check("a change made directly in MySQL is detected", sec.text.includes("FAILED") && sec.text.includes(`Audit record ${victim.id} was changed`));
check("the Accounting Supervisor is alerted", !!(await selectOne("SELECT id FROM notifications WHERE title = 'Audit trail check failed'")));
await exec("UPDATE audit_logs SET remarks = ? WHERE id = ?", [victim.remarks, victim.id]);
await sequelize.query(trigger);
t = await admin.csrf("/settings/security");
await admin.post("/settings/security/verify-audit", { _csrf: t });
check("once undone, the trail verifies again", (await admin.get("/settings/security")).text.includes("Audit trail verified"));

// ---- daily backup and retention clean-up
const { runDailyJobs } = await import(new URL("lib/scheduler.js", root).href);
const dir = process.env.BACKUP_DIR;
fs.mkdirSync(dir, { recursive: true });
const ancient = ["jvzpay-20200101-010101.sql.gz", "jvzpay-20200102-010101.sql.gz"];
for (const n of ancient) { const f = path.join(dir, n); fs.writeFileSync(f, "old"); fs.utimesSync(f, new Date("2020-01-02"), new Date("2020-01-02")); }
await exec("INSERT INTO password_resets (user_id, token_hash, expires_at, used_at) VALUES (?, REPEAT('a', 64), DATE_SUB(NOW(), INTERVAL 30 DAY), DATE_SUB(NOW(), INTERVAL 30 DAY))", [liza.id]);
await exec("UPDATE account_requests SET decided_at = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE email = 'ben@johnvivz.local'");
// an earlier stage may have saved the settings form with automatic backups off; this check is about the job itself
await exec("UPDATE system_settings SET setting_value = '1' WHERE setting_key = 'backup.auto_enabled'");
const before = new Set(fs.readdirSync(dir));
const done = await runDailyJobs({ force: true });
const made = fs.readdirSync(dir).filter((f) => !before.has(f) && /^jvzpay-[\d-]+\.sql\.gz$/.test(f));
const autoSetting = await selectOne("SELECT setting_value FROM system_settings WHERE setting_key = 'backup.auto_enabled'");
check("the daily job makes a backup", done.backup && made.length === 1, `done=${JSON.stringify(done)} made=${made.join(",")} auto_enabled=${autoSetting?.setting_value} files=${fs.readdirSync(dir).join(",")}`);
check("it is recorded as automatic", !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'backup_created' AND user_role = 'system'")));
check("backups past the retention period are removed", ancient.every((n) => !fs.existsSync(path.join(dir, n))));
check("old reset links are removed", !(await selectOne("SELECT id FROM password_resets WHERE token_hash = REPEAT('a', 64)")));
check("a rejected request's password is erased after 30 days", (await selectOne("SELECT password_hash FROM account_requests WHERE email = 'ben@johnvivz.local'")).password_hash === "");
const approved = await selectOne("SELECT password_hash, hr_code_enc FROM account_requests WHERE email = 'liza@johnvivz.local'");
check("an approved request keeps no password or HR code", approved.password_hash === "" && approved.hr_code_enc === "");

// ---- privacy notice: a new version must be read again
const all = await select("SELECT setting_key, setting_value, value_type FROM system_settings");
const form = Object.fromEntries(all.filter((s) => s.value_type !== "boolean" || s.setting_value === "1").map((s) => [s.setting_key.replace(/\./g, "__"), s.setting_value]));
t = await admin.csrf("/settings");
await admin.post("/settings", { _csrf: t, ...form, privacy__notice_version: "2026-12-01" });
r = await maria.get("/dashboard");
check("a new notice version is shown before anything else", r.status === 302 && r.loc === "/privacy/acknowledge");
t = await maria.csrf("/privacy/acknowledge");
r = await maria.post("/privacy/acknowledge", { _csrf: t });
check("the box must be ticked", r.status === 422);
r = await maria.post("/privacy/acknowledge", { _csrf: t, agree: "1" });
check("after acknowledging, back to work", r.status === 302 && r.loc === "/dashboard");
check("who acknowledged which version is recorded", (await selectOne("SELECT privacy_ack_version v FROM users WHERE email = 'maria@johnvivz.local'")).v === "2026-12-01");
t = await admin.csrf("/privacy/acknowledge");
await admin.post("/privacy/acknowledge", { _csrf: t, agree: "1" });

// ---- secrets stay out of version control
const ignore = fs.readFileSync(new URL(".gitignore", root), "utf8");
check(".env and storage are kept out of version control", /^\.env$/m.test(ignore) && /^storage\/$/m.test(ignore));

report();
await sequelize.close();
process.exit(0);
