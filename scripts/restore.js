// Restores a backup made on the Backup & Maintenance page. This replaces the current data, so it checks the file first
// and saves a safety copy of the current database before touching anything.
//   npm run restore -- storage/backups/jvzpay-20261109-170000.sql.gz
// Stop the app first, and restart it afterwards. Add --yes to skip the typed confirmation (used by automated tests).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { env } from "../config/env.js";
import { BACKUP_DIR, BACKUP_NAME, connectionArgs, dumpDatabase, findMysqlTool, newBackupName, toolEnv } from "../lib/mysqlTools.js";
import { exec, sequelize } from "../lib/db.js";

const fail = (message) => { console.error(`❌ ${message}`); process.exit(1); };

const args = process.argv.slice(2);
const given = args.find((a) => !a.startsWith("--"));
if (!given) fail("Say which backup to restore: npm run restore -- storage/backups/<file>.sql.gz");
const file = [path.resolve(given), path.join(BACKUP_DIR, path.basename(given))].find((p) => fs.existsSync(p));
if (!file) fail(`Backup not found: ${given}`);
if (!BACKUP_NAME.test(path.basename(file))) fail("That is not a JVzPay backup file (expected jvzpay-<date>.sql.gz).");

// read and check the whole file before changing anything
let sql;
try { sql = zlib.gunzipSync(fs.readFileSync(file)); } catch { fail("The backup file is damaged and cannot be unzipped. Nothing was changed."); }
const text = sql.toString("utf8");
if (!text.includes("CREATE TABLE `payroll_records`") || !/-- Dump completed/.test(text.slice(-200))) fail("The backup file is incomplete. Nothing was changed.");

console.log(`\nThis replaces ALL current data in database "${env.db.name}" with:\n  ${path.basename(file)}\n`);
if (!args.includes("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Stop the app first. To continue, type the database name (${env.db.name}): `);
  rl.close();
  if (answer.trim() !== env.db.name) fail("Cancelled. Nothing was changed.");
}

const safetyName = newBackupName();
console.log(`Saving a safety copy of the current data as ${safetyName} ...`);
try { await dumpDatabase(path.join(BACKUP_DIR, safetyName)); } catch (e) { fail(`${e.message} Nothing was changed.`); }

console.log("Restoring ...");
await new Promise((resolve) => {
  const child = spawn(findMysqlTool("mysql"), [...connectionArgs(), "--default-character-set=utf8mb4", env.db.name], { env: toolEnv(), windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", (e) => fail(`Could not run mysql (${e.code}). Set MYSQL_PATH in .env. Nothing was changed.`));
  child.on("close", (code) => {
    if (code !== 0) fail(`The restore failed: ${stderr.split("\n")[0].slice(0, 300)}\nThe previous data is saved in ${safetyName}.`);
    resolve();
  });
  child.stdin.end(sql);
});

await exec(
  "INSERT INTO audit_logs (user_name, user_role, action, module, record_type, record_id, remarks) VALUES ('Command line', 'System', 'database_restored', 'settings', 'backup', ?, ?)",
  [path.basename(file).slice(0, 40), `Database restored from ${path.basename(file)}. Previous data saved as ${safetyName}.`]
);
await sequelize.close();
console.log(`✅ Restored. If you need to undo this, restore ${safetyName}. Now start the app again.`);
