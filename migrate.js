/*
 * JVzPay migration runner (replaces the scaffold's `sequelize.sync({ force: true })`, which dropped every table).
 *
 *   npm run migrate                 apply pending migrations (safe, idempotent)
 *   npm run migrate -- --status     list applied / pending
 *   npm run migrate -- --fresh --yes   DROP the whole JVzPay database and rebuild (destructive, needs --yes)
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

const rootConn = await mysql.createConnection({
  host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password,
});

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

  const [appliedRows] = await rootConn.query("SELECT name, checksum FROM schema_migrations");
  const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  if (args.has("--status")) {
    for (const f of files) console.log(`${applied.has(f) ? "✅ applied " : "⏳ pending "} ${f}`);
    process.exit();
  }

  let ran = 0;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied. Never edit applied migrations; add a new one.`);
      }
      continue;
    }
    const statements = splitSql(sql);
    console.log(`▶ ${file} (${statements.length} statements)`);
    for (const [i, stmt] of statements.entries()) {
      try {
        await rootConn.query(stmt);
      } catch (err) {
        console.error(`❌ ${file} statement #${i + 1} failed:\n${stmt.slice(0, 300)}\n→ ${err.message}`);
        console.error('Fix the migration, then run "npm run migrate -- --fresh --yes" (DDL is not transactional).');
        process.exitCode = 1;
        process.exit();
      }
    }
    await rootConn.query("INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)", [file, checksum]);
    ran++;
  }
  console.log(ran ? `✅ Applied ${ran} migration(s).` : "✅ Database is up to date.");
} finally {
  await rootConn.end();
}
