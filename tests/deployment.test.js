// Deployment to AWS (docs/DEPLOY-AWS.md): the production start-up checks, the PM2 start, the scheduler rule,
// table-name case for Linux MySQL, the Nginx file and the production .env template.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { checkConfig, secretProblem, parseTrustProxy, parsePending } from "../config/productionCheck.js";
import { splitSql } from "../database/sqlSplit.js";
import { sequelize } from "../lib/db.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const rand = (n = 32) => crypto.randomBytes(n).toString("hex");
after(() => sequelize.close());

// a complete, valid production configuration (random throwaway values)
const goodProd = () => ({
  NODE_ENV: "production", PORT: "3002", HOST: "127.0.0.1", PUBLIC_BASE_URL: "https://johnvivz-pay.duckdns.org",
  TRUST_PROXY: "1", COOKIE_SECURE: "true", HTTPS_CERT_FILE: "", HTTPS_KEY_FILE: "",
  DB_HOST: "127.0.0.1", DB_PORT: "3306", DB_NAME: "JVzPay", DB_USER: "jvzpay", DB_PASSWORD: crypto.randomBytes(18).toString("base64url"),
  SESSION_SECRET: rand(48), DATA_ENCRYPTION_KEY: rand(32),
  HR_API_URL: "https://johnvivz-hr.duckdns.org", HR_API_PREFIX: "/api/integration/v1", HR_API_TOKEN: `jvhr_${rand(24)}`,
  CRM_API_URL: "https://johnvivz-crm.duckdns.org", CRM_API_PREFIX: "/api/integration/v1", CRM_API_SECRET: rand(32), CRM_INBOUND_SECRET: rand(32),
  INVENTORY_API_URL: "https://johnvivz-inventory.duckdns.org", INVENTORY_API_PREFIX: "/api/integration/v1", INVENTORY_API_TOKEN: `jvz_${rand(24)}`,
});
const errorsOf = (vars) => checkConfig(vars).errors.join("\n");

test("a complete production configuration starts without errors or warnings", () => {
  assert.deepEqual(checkConfig(goodProd()), { errors: [], warnings: [] });
});

test("production refuses missing required values, naming each variable", () => {
  for (const k of ["PUBLIC_BASE_URL", "DB_PASSWORD", "SESSION_SECRET", "DATA_ENCRYPTION_KEY", "HR_API_URL", "HR_API_PREFIX", "HR_API_TOKEN",
    "CRM_API_URL", "CRM_API_SECRET", "CRM_INBOUND_SECRET", "INVENTORY_API_URL", "INVENTORY_API_TOKEN"]) {
    const v = goodProd(); delete v[k];
    assert.match(errorsOf(v), new RegExp(`\\b${k}\\b`), `${k} missing must be refused`);
  }
});

test("production refuses short, placeholder, non-random and reused secrets", () => {
  assert.match(errorsOf({ ...goodProd(), CRM_INBOUND_SECRET: "abc123" }), /CRM_INBOUND_SECRET is too short/);
  assert.match(errorsOf({ ...goodProd(), SESSION_SECRET: rand(16) }), /SESSION_SECRET is too short/); // 32 chars < 64
  assert.match(errorsOf({ ...goodProd(), HR_API_TOKEN: "CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME" }), /HR_API_TOKEN is a placeholder/);
  assert.match(errorsOf({ ...goodProd(), DB_PASSWORD: "Password#123" }), /DB_PASSWORD is a placeholder or default/);
  assert.match(errorsOf({ ...goodProd(), CRM_API_SECRET: "a".repeat(64) }), /CRM_API_SECRET is not random/);
  assert.match(errorsOf({ ...goodProd(), DATA_ENCRYPTION_KEY: "0".repeat(64) }), /DATA_ENCRYPTION_KEY is not random/);
  assert.match(errorsOf({ ...goodProd(), DATA_ENCRYPTION_KEY: rand(16) }), /exactly 64 hex/);
  const same = rand(32);
  assert.match(errorsOf({ ...goodProd(), CRM_API_SECRET: same, CRM_INBOUND_SECRET: same }), /CRM_INBOUND_SECRET has the same value as CRM_API_SECRET/);
  assert.match(errorsOf({ ...goodProd(), INVENTORY_API_SECRET: "short" }), /INVENTORY_API_SECRET is too short/); // optional, but checked when set
  assert.equal(secretProblem(rand(32)), null);
});

test("production refuses an unsafe web-server setup behind Nginx", () => {
  assert.match(errorsOf({ ...goodProd(), HOST: "0.0.0.0" }), /must listen on 127\.0\.0\.1/);
  assert.match(errorsOf({ ...goodProd(), HTTPS_CERT_FILE: "/etc/ssl/a.pem", HTTPS_KEY_FILE: "/etc/ssl/a.key" }), /must stay empty/);
  assert.match(errorsOf({ ...goodProd(), PUBLIC_BASE_URL: "http://johnvivz-pay.duckdns.org" }), /PUBLIC_BASE_URL must use https/);
  assert.match(errorsOf({ ...goodProd(), PUBLIC_BASE_URL: "https://johnvivz-pay.duckdns.org/app" }), /without a path/);
  assert.match(errorsOf({ ...goodProd(), HR_API_URL: "http://johnvivz-hr.duckdns.org" }), /HR_API_URL must use https/);
  assert.match(errorsOf({ ...goodProd(), CRM_API_URL: "https://johnvivz-crm.duckdns.org/api/integration/v1" }), /CRM_API_PREFIX/);
  assert.match(errorsOf({ ...goodProd(), DB_USER: "root" }), /DB_USER=root/);
  // COOKIE_SECURE without TRUST_PROXY would break every sign-in behind Nginx
  assert.match(errorsOf({ ...goodProd(), TRUST_PROXY: "false" }), /COOKIE_SECURE=true needs TRUST_PROXY=1/);
  // before certbot: COOKIE_SECURE=false is allowed but warned about
  const w = checkConfig({ ...goodProd(), COOKIE_SECURE: "false" });
  assert.equal(w.errors.length, 0);
  assert.match(w.warnings.join("\n"), /COOKIE_SECURE is off/);
});

test("PENDING_INTEGRATIONS lets an app whose server is not ready be left out, with a warning", () => {
  const v = goodProd();
  for (const k of ["INVENTORY_API_URL", "INVENTORY_API_PREFIX", "INVENTORY_API_TOKEN"]) delete v[k];
  assert.match(errorsOf(v), /INVENTORY_API_URL is missing/);
  const r = checkConfig({ ...v, PENDING_INTEGRATIONS: "inventory" });
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join("\n"), /Inventory is not checked yet/);
  assert.match(errorsOf({ ...goodProd(), PENDING_INTEGRATIONS: "payroll" }), /not one of hr, crm, inventory/);
  assert.deepEqual(parsePending(" HR, inventory ,"), ["hr", "inventory"]);
});

test("a laptop (development) needs none of the production values, and http sign-in keeps working", () => {
  assert.deepEqual(checkConfig({ NODE_ENV: "development" }).errors, []);
  assert.deepEqual(checkConfig({}).errors, []);
  // the one combination that breaks sign-in is refused everywhere
  assert.match(errorsOf({ NODE_ENV: "development", COOKIE_SECURE: "true" }), /COOKIE_SECURE=true needs TRUST_PROXY=1/);
  assert.deepEqual(checkConfig({ NODE_ENV: "development", COOKIE_SECURE: "true", HTTPS_CERT_FILE: "c.pem", HTTPS_KEY_FILE: "k.pem" }).errors, []);
});

test("TRUST_PROXY: default off, true = one hop (Nginx)", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("true"), 1);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("2"), 2);
  assert.equal(parseTrustProxy("loopback"), "loopback");
});

test(".env.production.example lists every setting the code reads, and holds no secret", () => {
  const template = read(".env.production.example");
  const listed = new Map([...template.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
  // every process.env.NAME in the application code (tests and test-only switches excluded)
  const used = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (!["node_modules", "tests", ".git", "storage", "public"].includes(e.name)) walk(rel); continue; }
      if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
      for (const m of fs.readFileSync(path.join(root, rel), "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
    }
  };
  walk(".");
  // names built at run time: {APP}_API_URL/_PREFIX/_TOKEN/_SECRET, {APP}_EVENTS_ENABLED, *_INBOUND_SECRET, MYSQL(DUMP)_PATH
  for (const app of ["HR", "CRM", "INVENTORY"]) for (const s of ["_API_URL", "_API_PREFIX", "_API_TOKEN", "_API_SECRET", "_EVENTS_ENABLED", "_INBOUND_SECRET"]) used.add(app + s);
  for (const k of ["SESSION_SECRET", "DATA_ENCRYPTION_KEY", "MYSQL_PATH", "MYSQLDUMP_PATH", "CRM_DEPARTMENT_CODES", "INVENTORY_DEPARTMENT_CODES"]) used.add(k);
  const notForServers = new Set(["XIAN_ELECTRON", "NODE_APP_INSTANCE"]); // Electron wrapper / set by PM2 itself
  const missing = [...used].filter((k) => !listed.has(k) && !notForServers.has(k));
  assert.deepEqual(missing, [], "add these to .env.production.example");
  for (const [k, v] of listed) {
    if (/SECRET|TOKEN|PASSWORD|_KEY$|_PASS$/.test(k) && !["HTTPS_KEY_FILE"].includes(k)) assert.equal(v, "", `${k} must be empty in the template (no real secrets)`);
  }
  assert.equal(listed.get("NODE_ENV"), "production");
  assert.equal(listed.get("HOST"), "127.0.0.1");
  assert.equal(listed.get("TRUST_PROXY"), "1");
  assert.equal(listed.get("HTTPS_CERT_FILE"), "");
  assert.equal(listed.get("DB_NAME"), "JVzPay");
  // the committed laptop template holds no secrets either
  for (const m of read(".env.example").matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
    if (/SECRET|TOKEN|_API_KEY|DATA_ENCRYPTION_KEY|ADMIN_PASSWORD|DB_PASSWORD/.test(m[1])) assert.equal(m[2], "", `.env.example: ${m[1]} must be empty`);
  }
});

test("Linux MySQL: every table name is lowercase and written the same way everywhere", () => {
  const created = new Set();
  const migrations = fs.readdirSync(path.join(root, "database/migrations")).filter((f) => f.endsWith(".sql"));
  for (const f of migrations) {
    for (const m of read(`database/migrations/${f}`).matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)/gi)) {
      assert.equal(m[1], m[1].toLowerCase(), `${f}: table ${m[1]} must be lowercase`);
      created.add(m[1]);
    }
  }
  for (const t of ["schema_migrations", "schema_migration_progress"]) created.add(t); // made by migrate.js
  // every model maps to a table created with exactly that name
  for (const f of fs.readdirSync(path.join(root, "models")).filter((f) => f.endsWith("Model.js"))) {
    const name = /tableName:\s*"([^"]+)"/.exec(read(`models/${f}`))?.[1];
    assert.ok(name && created.has(name), `models/${f}: tableName "${name}" is not a table created by a migration (case-sensitive)`);
  }
  // raw SQL in code and migrations: a known table written in another case would fail on Linux
  const lower = new Map([...created].map((t) => [t.toLowerCase(), t]));
  const files = [
    ...migrations.map((f) => `database/migrations/${f}`), "migrate.js", "database/seeds/run.js",
    ...["services", "controllers", "lib", "middleware", "scripts", "config", "routes"].flatMap((d) =>
      fs.readdirSync(path.join(root, d), { recursive: true }).filter((f) => /\.js$/.test(f)).map((f) => `${d}/${f}`.replace(/\\/g, "/"))),
  ];
  const bad = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE|EXISTS|ON)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/g)) {
      const t = lower.get(m[1].toLowerCase());
      if (t && t !== m[1]) bad.push(`${f}: "${m[1]}" should be "${t}"`);
    }
  }
  assert.deepEqual(bad, []);
});

test("migrations that create triggers are documented with the binary-log fix", () => {
  const withTriggers = fs.readdirSync(path.join(root, "database/migrations")).filter((f) => /CREATE\s+(DEFINER\S*\s+)?(TRIGGER|FUNCTION|PROCEDURE)/i.test(read(`database/migrations/${f}`)));
  assert.ok(withTriggers.length > 0);
  const guide = read("docs/DEPLOY-AWS.md");
  assert.ok(guide.includes('sudo mysql -e "SET PERSIST log_bin_trust_function_creators = 1;"'));
  const fix = guide.indexOf('sudo mysql -e "SET PERSIST log_bin_trust_function_creators = 1;"');
  const firstMigrateRun = guide.search(/^npm run migrate\b/m); // the first time the guide has you run it
  assert.ok(fix > 0 && firstMigrateRun > 0 && fix < firstMigrateRun, "the one-time fix comes before npm run migrate");
  // the runner resumes a partly applied migration at the failed statement
  assert.match(read("migrate.js"), /schema_migration_progress/);
  assert.ok(splitSql(read("database/migrations/001_access_org_platform.sql")).some((s) => /^CREATE TRIGGER/i.test(s)));
});

test("PM2: index.js starts the server without a main-module check; one fork-mode instance", () => {
  const index = read("index.js").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(index, /require\.main\s*===|import\.meta\.url\s*===|===\s*import\.meta\.url|pathToFileURL\(process\.argv\[1\]\)/);
  const require = createRequire(import.meta.url);
  const { apps } = require("../ecosystem.config.cjs");
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, "jvzpay");
  assert.equal(apps[0].exec_mode, "fork");
  assert.equal(apps[0].instances, 1);
  assert.ok(["index.js", "npm"].includes(apps[0].script));
  assert.match(read("lib/scheduler.js"), /NODE_APP_INSTANCE/);
});

test("Nginx site: server name, no path after proxy_pass, the API open only to the allow list", () => {
  const conf = read("deploy/nginx-site.conf");
  const live = conf.replace(/#.*$/gm, "");
  assert.match(live, /server_name\s+johnvivz-pay\.duckdns\.org;/);
  const passes = [...live.matchAll(/proxy_pass\s+([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(passes.length >= 3);
  for (const p of passes) assert.equal(p, "http://jvzpay", "proxy_pass must have no path, so path, query and body reach the app unchanged");
  assert.match(live, /server\s+127\.0\.0\.1:3002;/);
  const api = /location\s+~\*\s+\^\/api\/\(integration\|v1\)\(\/\|\$\)\s*\{([\s\S]*?)\n\s{4}\}/.exec(live);
  assert.ok(api, "a case-insensitive location for /api/integration/ and /api/v1/");
  assert.equal((api[1].match(/^\s*allow\s/gm) || []).length, 3);
  assert.match(api[1], /deny\s+all;/);
  for (const h of ["X-Forwarded-For", "X-Forwarded-Proto"]) assert.ok(api[1].includes(h));
  assert.match(live, /client_max_body_size\s+\d+m;/);
});

// a free port on 127.0.0.1
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function run(args, env, { until, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: "timeout", out }); }, timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
    if (until) until(child, () => out).then((v) => { clearTimeout(timer); child.kill(); resolve({ code: "ok", out, value: v }); });
  });
}

test("loaded the way PM2 loads it (index.js imported, not the main module), the app starts and answers /health", async () => {
  const port = await freePort();
  // process.argv[1] is not index.js here, exactly like under PM2's ProcessContainerFork.js
  const r = await run(["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)});`],
    { NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", DISABLE_SCHEDULER: "1", TRUST_PROXY: "", COOKIE_SECURE: "", PUBLIC_BASE_URL: "" }, {
      until: async () => {
        for (let i = 0; i < 200; i++) {
          try { const res = await fetch(`http://127.0.0.1:${port}/health`); if (res.ok) return res.json(); } catch { /* not yet */ }
          await new Promise((s) => setTimeout(s, 250));
        }
        return null;
      },
    });
  assert.equal(r.code, "ok", r.out.slice(-1500));
  assert.deepEqual(r.value, { status: "ok" });
  assert.match(r.out, /running at http:\/\/127\.0\.0\.1:/);
});

test("in production the app refuses to start with missing settings and says which", async () => {
  const blank = Object.fromEntries(["SESSION_SECRET", "DATA_ENCRYPTION_KEY", "PUBLIC_BASE_URL", "DB_PASSWORD", "HR_API_URL", "HR_API_TOKEN", "CRM_API_URL",
    "CRM_API_SECRET", "CRM_INBOUND_SECRET", "INVENTORY_API_URL", "INVENTORY_API_TOKEN", "PENDING_INTEGRATIONS", "HOST", "TRUST_PROXY", "COOKIE_SECURE"].map((k) => [k, ""]));
  const r = await run(["index.js"], { ...blank, NODE_ENV: "production", DB_USER: "jvzpay", PORT: String(await freePort()), DISABLE_SCHEDULER: "1" });
  assert.equal(r.code, 1, r.out.slice(-800));
  assert.match(r.out, /JVzPay will not start/);
  for (const k of ["SESSION_SECRET", "DATA_ENCRYPTION_KEY", "PUBLIC_BASE_URL", "CRM_INBOUND_SECRET", "INVENTORY_API_TOKEN"]) assert.match(r.out, new RegExp(k));
});

test("DATA_ENCRYPTION_KEY: a different key than the data's is detected", async () => {
  const { checkEncryptionKey } = await import("../lib/keyCheck.js");
  const ok = await checkEncryptionKey();
  assert.equal(ok.problem, null, ok.problem);
  if (!ok.checked) return; // a database without encrypted values yet: nothing to compare
  const saved = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = rand(32);
  try {
    const wrong = await checkEncryptionKey();
    assert.match(wrong.problem || "", /does not match the data/);
  } finally { process.env.DATA_ENCRYPTION_KEY = saved; }
});
