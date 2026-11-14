// Shared by the Backup page and scripts/restore.js: locating the MySQL command-line tools and writing a compressed dump.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(root, "storage", "backups");
export const BACKUP_NAME = /^jvzpay-[\d-]+\.sql\.gz$/;

/** `name` is "mysql" or "mysqldump". MYSQL_PATH / MYSQLDUMP_PATH in .env override the search. */
export function findMysqlTool(name) {
  const override = process.env[`${name.toUpperCase()}_PATH`];
  if (override) return override;
  const laragon = "C:/laragon/bin/mysql";
  try {
    for (const dir of fs.readdirSync(laragon)) {
      const p = path.join(laragon, dir, "bin", `${name}.exe`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* not a Laragon install */ }
  return name;
}

export const toolEnv = () => ({ ...process.env, MYSQL_PWD: env.db.password });
export const connectionArgs = () => ["-h", env.db.host, "-P", String(env.db.port), "-u", env.db.user];

export function newBackupName() {
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Manila" }).replace(/[^\d]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2");
  return `jvzpay-${stamp}.sql.gz`;
}

/** Writes a gzip-compressed mysqldump to `file`. Rejects with a readable message, leaving no partial file behind. */
export function dumpDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(findMysqlTool("mysqldump"),
      [...connectionArgs(), "--single-transaction", "--routines", "--triggers", "--no-tablespaces", "--default-character-set=utf8mb4", env.db.name],
      { env: toolEnv(), windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => reject(new Error(`Could not run mysqldump (${e.code}). Set MYSQLDUMP_PATH in .env.`)));
    const closed = new Promise((res) => child.on("close", res));
    pipeline(child.stdout, zlib.createGzip(), fs.createWriteStream(file)).then(async () => {
      if ((await closed) === 0) return resolve();
      fs.rmSync(file, { force: true });
      reject(new Error(`Backup failed: ${stderr.split("\n")[0].slice(0, 200)}`));
    }).catch(reject);
  });
}
