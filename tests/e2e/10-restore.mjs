// Recovery procedure: a backup made on the Backup page can be restored with `npm run restore`, damaged files are refused.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client, check, report, db } from "./lib.mjs";

const base = process.argv[2];
const { selectOne, sequelize } = db;
const restore = (...args) => spawnSync(process.execPath, ["scripts/restore.js", ...args], { cwd: new URL("../../", import.meta.url), env: process.env, encoding: "utf8" });
const dir = process.env.BACKUP_DIR;
const backups = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql.gz")) : []);
const count = async (q) => Number((await selectOne(q)).n);

const admin = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
const t = await admin.csrf("/settings/backup");
const before = new Set(backups());
await admin.post("/settings/backup", { _csrf: t });
const name = backups().find((f) => !before.has(f));
check("backup file created", !!name);
const file = path.join(dir, name);

const triggers = await count("SELECT COUNT(*) n FROM information_schema.triggers WHERE trigger_schema = DATABASE()");
const employees = await count("SELECT COUNT(*) n FROM employees");
await new Promise((r) => setTimeout(r, 1100)); // backup names have one-second resolution

// refused before anything changes
const damaged = path.join(dir, "jvzpay-1.sql.gz");
fs.writeFileSync(damaged, fs.readFileSync(file).subarray(0, 400));
let r = restore(damaged, "--yes");
check("damaged backup refused", r.status !== 0 && /damaged|incomplete/.test(r.stderr), r.stderr);
fs.rmSync(damaged);
const stray = path.join(dir, "notes.sql.gz");
fs.copyFileSync(file, stray);
r = restore(stray, "--yes");
check("file with the wrong name refused", r.status !== 0, r.stderr);
fs.rmSync(stray);
r = restore("no-such-file.sql.gz", "--yes");
check("missing file refused", r.status !== 0);

// a change made after the backup disappears when it is restored
const form = await admin.csrf("/settings/announcements");
await admin.post("/settings/announcements", { _csrf: form, title: "RESTORE-MARKER", body: "Made after the backup.", audience: "all" });
check("marker exists before restore", (await count("SELECT COUNT(*) n FROM announcements WHERE title = 'RESTORE-MARKER'")) === 1);
const beforeRestore = new Set(backups());
r = restore(file, "--yes");
check("restore succeeds", r.status === 0, r.stderr || r.stdout);
check("marker is gone after restore", (await count("SELECT COUNT(*) n FROM announcements WHERE title = 'RESTORE-MARKER'")) === 0);
check("triggers are back", (await count("SELECT COUNT(*) n FROM information_schema.triggers WHERE trigger_schema = DATABASE()")) === triggers);
check("records are back", (await count("SELECT COUNT(*) n FROM employees")) === employees);
const safety = backups().find((f) => !beforeRestore.has(f));
check("a safety copy of the replaced data was saved", !!safety);
check("the restore is in the audit trail", !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'database_restored'")));

// undoing the restore brings the marker back
await new Promise((res) => setTimeout(res, 1100));
r = restore(safety, "--yes");
check("restoring the safety copy undoes it", r.status === 0 && (await count("SELECT COUNT(*) n FROM announcements WHERE title = 'RESTORE-MARKER'")) === 1, r.stderr);
report();
await sequelize.close();
