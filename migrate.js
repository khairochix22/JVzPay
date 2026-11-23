/*
 * JVzPay migration runner (replaces the scaffold's `sequelize.sync({ force: true })`, which dropped every table).
 *
 *   npm run migrate                 apply pending migrations (safe to re-run)
 *   npm run migrate -- --status     list applied / pending / partly applied
 *   npm run migrate -- --fresh --yes   DROP the whole JVzPay database and rebuild (destructive, needs --yes)
 *
 * Safe to re-run after a failure: MySQL 8 runs each DDL statement atomically, and the runner records in
 * schema_migration_progress how many statements of an unfinished migration already succeeded. Fix the cause (the
 * message says how), run `npm run migrate` again, and it continues with the statement that failed — it never runs the
 * finished ones twice. Applied migrations are never edited: their checksum is checked on every run.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import mysql from "mysql2/promise";
import { fileURLToPath } from "url";
import { env } from "./config/env.js";
import { splitSql } from "./database/sqlSplit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "database", "migrations");
const args = new Set(process.argv.slice(2));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
// fingerprint of the first `n` statements: a resumed run continues only if those are still the same
const prefixChecksum = (statements, n) => sha256(statements.slice(0, n).join("\n;\n"));

/** What to do about a failed statement, in plain words. */
function adviceFor(err) {
  const user = `'${env.db.user}'@'localhost'`;
  switch (err.errno) {
    case 1419: // ER_BINLOG_CREATE_ROUTINE_NEED_SUPER: binary logging on, a user without SUPER creating a trigger/function
      return [
        "This migration creates a TRIGGER. MySQL 8.4 on Ubuntu has binary logging on, so a user without SUPER (the jvzpay",
        "user) may create triggers only when log_bin_trust_function_creators is 1. Run this ONCE on the server:",
        '    sudo mysql -e "SET PERSIST log_bin_trust_function_creators = 1;"',
        "then run npm run migrate again: it continues with this statement (docs/DEPLOY-AWS.md §4).",
      ].join("\n");
    case 1044: case 1142: case 1143: case 1227: case 1370:
      return [
        `The MySQL user ${user} lacks a privilege. Give it every privilege on the ${env.db.name} database only:`,
        `    sudo mysql -e "GRANT ALL PRIVILEGES ON \\\`${env.db.name}\\\`.* TO ${user}; FLUSH PRIVILEGES;"`,
        "then run npm run migrate again: it continues with this statement.",
      ].join("\n");
    case 1146: // ER_NO_SUCH_TABLE
      return "A table this statement needs does not exist. On Linux, table names are case-sensitive: check that the name is written exactly as in its CREATE TABLE (all lowercase in JVzPay). Then run npm run migrate again.";
    default:
      return [
        "Fix the cause, then run npm run migrate again: it continues with this statement and skips the ones that already",
        "succeeded. Never edit a migration that is already applied on any server; add a new one.",
        "Only on a database WITHOUT real data, you may instead rebuild it from scratch: npm run migrate -- --fresh --yes",
      ].join("\n");
  }
}

let rootConn;
try {
  rootConn = await mysql.createConnection({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password });
} catch (err) {
  console.error(`❌ Cannot connect to MySQL at ${env.db.host}:${env.db.port} as ${env.db.user}: ${err.message}\n   Check DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in .env.`);
  process.exit(1);
}

try {
  if (args.has("--fresh")) {
    if (!args.has("--yes")) {
      console.error(`❌ --fresh DROPS database "${env.db.name}" and all of its data. Re-run with --fresh --yes to confirm.`);
      process.exitCode = 1;
      process.exit();
    }
    await rootConn.query(`DROP DATABASE IF EXISTS \`${env.db.name}\``);
    console.log(`🗑  Dropped database ${env.db.name}`);
  }

  // The name is used exactly as written in DB_NAME: on Linux "JVzPay" and "jvzpay" are two different databases.
  await rootConn.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await rootConn.query(`USE \`${env.db.name}\``);
  await rootConn.query("SET time_zone = '+08:00'");
  await rootConn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
  // an unfinished migration: how many of its statements already succeeded (the row goes once the migration completes)
  await rootConn.query(`CREATE TABLE IF NOT EXISTS schema_migration_progress (
      name VARCHAR(190) NOT NULL PRIMARY KEY,
      statements_done INT UNSIGNED NOT NULL,
      done_checksum CHAR(64) NOT NULL,
      last_error VARCHAR(1000) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

  const [appliedRows] = await rootConn.query("SELECT name, checksum FROM schema_migrations");
  const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]));
  const [progressRows] = await rootConn.query("SELECT name, statements_done, done_checksum, last_error FROM schema_migration_progress");
  const progress = new Map(progressRows.map((r) => [r.name, r]));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  if (args.has("--status")) {
    for (const f of files) {
      const p = progress.get(f);
      if (applied.has(f)) console.log(`✅ applied  ${f}`);
      else if (p) console.log(`⚠️  partly   ${f} (${p.statements_done} statements done; last error: ${p.last_error || "-"}) → fix it and run npm run migrate`);
      else console.log(`⏳ pending  ${f}`);
    }
    process.exit();
  }

  const saveProgress = (file, statements, done, error = null) => rootConn.query(
    `INSERT INTO schema_migration_progress (name, statements_done, done_checksum, last_error) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE statements_done = VALUES(statements_done), done_checksum = VALUES(done_checksum), last_error = VALUES(last_error)`,
    [file, done, prefixChecksum(statements, done), error ? String(error).slice(0, 1000) : null]);

  let ran = 0;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const checksum = sha256(sql);
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied. Never edit applied migrations; add a new one.`);
      }
      continue;
    }
    const statements = splitSql(sql);
    let start = 0;
    const partial = progress.get(file);
    if (partial) {
      const done = Number(partial.statements_done);
      if (done > statements.length || prefixChecksum(statements, done) !== partial.done_checksum) {
        console.error(`❌ ${file} was partly applied earlier (${done} statements), and those statements have changed since.\n` +
          "   The runner cannot tell what is in the database now. Restore the backup taken before the migration (or, on a\n" +
          "   database without real data, rebuild it: npm run migrate -- --fresh --yes).");
        process.exitCode = 1;
        process.exit();
      }
      start = done;
      console.log(`↻ ${file}: resuming at statement #${start + 1} of ${statements.length} (the first ${start} already succeeded)`);
    } else {
      console.log(`▶ ${file} (${statements.length} statements)`);
    }
    for (let i = start; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        await rootConn.query(stmt);
      } catch (err) {
        await saveProgress(file, statements, i, `#${i + 1}: ${err.message}`).catch(() => {});
        console.error(`❌ ${file} statement #${i + 1} of ${statements.length} failed:\n${stmt.slice(0, 300)}\n→ ${err.code || ""} ${err.message}\n`);
        console.error(adviceFor(err));
        process.exitCode = 1;
        process.exit();
      }
      // progress after every statement, so even a crash or a lost connection resumes at the right place
      await saveProgress(file, statements, i + 1);
    }
    await rootConn.query("INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)", [file, checksum]);
    await rootConn.query("DELETE FROM schema_migration_progress WHERE name = ?", [file]);
    ran++;
  }
  console.log(ran ? `✅ Applied ${ran} migration(s).` : "✅ Database is up to date.");
} finally {
  await rootConn.end();
}
