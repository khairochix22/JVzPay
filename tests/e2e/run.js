// End-to-end tests: real HTTP requests and a real browser against a real server.
// The database is DROPPED and rebuilt several times, so this refuses to run unless DB_NAME ends in "_test".
//
//   PowerShell:  $env:DB_NAME="JVzPay_test"; npm run test:e2e
//   Git Bash:    DB_NAME=JVzPay_test npm run test:e2e
//
// Uploads and backups go to a temporary folder. The server is restarted between stages because the login rate limit
// (30 attempts per 15 minutes, kept in memory) is correct for production and is not relaxed for testing.
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { env } from "../../config/env.js";
import { spawnFakeApps } from "./fakeApps.mjs";

if (!/_test$/i.test(env.db.name)) {
  console.error(`Refusing to run: these tests DROP the database, and DB_NAME is "${env.db.name}".\nUse a throwaway database whose name ends in _test, for example: $env:DB_NAME="JVzPay_test"; npm run test:e2e`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(here, "..", "..");
const port = process.env.E2E_PORT || "3311";
const base = `http://localhost:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jvzpay-e2e-"));
// fake HR (pull-only, verify) and Inventory (outbox) applications for the whole run (fakeApps.mjs)
const fakeTokens = { hrToken: crypto.randomBytes(24).toString("hex"), inventoryToken: crypto.randomBytes(24).toString("hex") };
const fakes = await spawnFakeApps(fakeTokens);
const childEnv = { ...process.env, NODE_ENV: "development", DISABLE_SCHEDULER: "1",
  // laptop defaults (stage 23 restarts the server as it runs behind Nginx); never taken from the developer's .env
  HOST: "", PUBLIC_BASE_URL: "", TRUST_PROXY: "false", COOKIE_SECURE: "false", PENDING_INTEGRATIONS: "", PORT: port, DB_NAME: env.db.name, UPLOAD_DIR: path.join(tmp, "uploads"), BACKUP_DIR: path.join(tmp, "backups"),
  // a throwaway secret for the signed-request (CRM contract) checks in stages 15 and 17
  CRM_INBOUND_SECRET: crypto.randomBytes(32).toString("hex"),
  HR_API_URL: fakes.hrUrl, HR_API_PREFIX: "/api/integration/v1", HR_API_TOKEN: fakeTokens.hrToken, HR_API_SECRET: "", HR_EVENTS_ENABLED: "",
  INVENTORY_API_URL: fakes.invUrl, INVENTORY_API_PREFIX: "/api/integration/v1", INVENTORY_API_TOKEN: fakeTokens.inventoryToken, INVENTORY_API_SECRET: "",
  CRM_API_URL: "", CRM_DEPARTMENT_CODES: "", INVENTORY_DEPARTMENT_CODES: "", HR_COMPENSATION_PATH: "", ACCOUNTING_DEPARTMENT_CODE: "", POSITION_ROLES: "", DEPARTMENT_SUPERVISOR_TITLES: "" };
const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase(), adminPass = process.env.ADMIN_PASSWORD;

let totalPassed = 0, totalChecks = 0, failed = false, server, currentBase = base;
// how the app runs on the AWS server behind Nginx (docs/DEPLOY-AWS.md): stage 23
const BEHIND_NGINX = { TRUST_PROXY: "1", COOKIE_SECURE: "true", PUBLIC_BASE_URL: "https://johnvivz-pay.duckdns.org", HOST: "127.0.0.1" };

function node(args) {
  const r = spawnSync(process.execPath, args, { cwd: project, env: childEnv, encoding: "utf8", maxBuffer: 1 << 26, timeout: 900000 });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function freshDatabase() {
  fs.rmSync(childEnv.UPLOAD_DIR, { recursive: true, force: true });
  for (const args of [["migrate.js", "--fresh", "--yes"], ["database/seeds/run.js"]]) {
    const r = node(args);
    if (r.code !== 0) { console.error(`${args[0]} failed:\n${r.out}`); process.exit(1); }
  }
}

async function startServer(extraEnv = {}, url = base) {
  let output = "";
  currentBase = url;
  server = spawn(process.execPath, ["index.js"], { cwd: project, env: { ...childEnv, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout.on("data", (d) => { output += d; });
  server.stderr.on("data", (d) => { output += d; });
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${url}/login`)).ok) return; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`The test server did not start.\n${output.slice(-1500)}`); process.exit(1);
}

async function stopServer() {
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
}

function unlockAccounts() {
  node(["--input-type=module", "-e", `const { exec, sequelize } = await import(${JSON.stringify(new URL("../../lib/db.js", import.meta.url).href)}); await exec("UPDATE users SET failed_login_attempts = 0, locked_until = NULL"); await sequelize.close();`]);
}

function runScript(file, ...args) {
  const r = node([path.join(here, file), currentBase, ...args]);
  const lines = r.out.split("\n").filter((l) => !/deprecat|trace-deprecation|Assertion failed: !\(handle/i.test(l));
  for (const l of lines) if (/^FAIL|^PROBLEM|Error:|^\s+at file|backup failed/.test(l)) console.log(`  ${l.slice(0, 500)}`);
  const passed = /(\d+)\/(\d+) passed/.exec(r.out), problems = /(\d+) problem\(s\)/.exec(r.out);
  let summary = "did not finish";
  if (passed) {
    totalPassed += Number(passed[1]); totalChecks += Number(passed[2]); summary = `${passed[1]}/${passed[2]} passed`;
    if (passed[1] !== passed[2]) failed = true;
  } else if (problems) {
    summary = `${problems[1]} problem(s)`;
    if (problems[1] !== "0") failed = true;
  } else failed = true;
  console.log(`${file.padEnd(30)} ${summary}`);
}

if (!process.argv.includes("--browser-only")) {
  freshDatabase();
  await startServer();
  runScript("03-accounts.mjs", adminEmail, adminPass);
  // each later stage gets a fresh server, so the sign-ins of earlier stages do not count against its rate limit
  for (const [script, ...args] of [["04-self-service.mjs", path.join(tmp, "payslip.pdf")], ["05-attendance-leave.mjs"], ["06-payroll.mjs"], ["07-accounting-reports.mjs"]]) {
    await stopServer();
    await startServer();
    unlockAccounts();
    runScript(script, ...args);
  }
  await stopServer();

  await startServer();
  unlockAccounts();
  runScript("09-administration.mjs");
  runScript("10-route-sweep.mjs");
  runScript("10-restore.mjs");
  await stopServer();

  // a changed password must survive a restart
  await startServer();
  unlockAccounts();
  runScript("12-password-change.mjs", "before");
  await stopServer();
  await startServer();
  runScript("12-password-change.mjs", "after");
  unlockAccounts();
  runScript("13-security.mjs");
  await stopServer();
  // a fresh server per stage, so the sign-ins of one stage do not count against the next one's rate limit
  for (const script of ["14-integration.mjs", "15-ess-registration.mjs", "16-enrollments.mjs", "17-finance.mjs", "18-department-routing.mjs", "19-timekeeping-retirement.mjs", "20-staff-approvals-loans.mjs", "21-two-step-approval.mjs", "22-hr-pull-inventory-poll.mjs"]) {
    await startServer();
    unlockAccounts();
    runScript(script);
    await stopServer();
  }
  // as on the AWS server: behind Nginx, HTTPS at Nginx, listening on 127.0.0.1 only
  await startServer(BEHIND_NGINX, `http://127.0.0.1:${port}`);
  unlockAccounts();
  runScript("23-behind-proxy.mjs");
  await stopServer();
  currentBase = base;
}

if (!process.argv.includes("--no-browser")) {
  freshDatabase();
  await startServer();
  runScript("11-browser-journeys.mjs", adminEmail, adminPass);
  await stopServer();
}

fakes.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${totalPassed}/${totalChecks} checks passed${failed ? " — FAILURES ABOVE" : ""}`);
process.exit(failed ? 1 : 0);
