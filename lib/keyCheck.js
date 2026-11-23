// Start-up check of DATA_ENCRYPTION_KEY against the data. Bank account and government ID numbers are stored AES-256-GCM
// encrypted (lib/crypto.js) in the *_enc columns. A different key cannot open them, and GCM tells us so for certain: this
// decrypts one stored value. A wrong key (for example a new one generated on a new server, or a database restored without
// its key) is caught here, before anyone sees "••••" instead of an account number or saves new data under the wrong key.
import { env } from "../config/env.js";
import { select } from "./db.js";
import { decrypt } from "./crypto.js";

/** { problem: null } when the key opens the data (or there is no encrypted data yet), else { problem: "<message>" }. */
export async function checkEncryptionKey() {
  if (!process.env.DATA_ENCRYPTION_KEY) {
    return { problem: "DATA_ENCRYPTION_KEY is not set: bank account and government ID numbers cannot be read or saved. Restore it from your key backup (docs/DEPLOY-AWS.md §9)." };
  }
  try { void env.dataKey; } catch (e) { return { problem: e.message }; }
  const columns = await select(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND COLUMN_NAME LIKE '%\\_enc' ORDER BY TABLE_NAME, COLUMN_NAME`, [env.db.name]);
  for (const { t, c } of columns) {
    const [row] = await select(`SELECT \`${c}\` AS v FROM \`${t}\` WHERE \`${c}\` IS NOT NULL AND \`${c}\` LIKE 'v1:%' LIMIT 1`);
    if (!row) continue;
    try {
      decrypt(row.v);
      return { problem: null, checked: `${t}.${c}` };
    } catch {
      return { problem: `DATA_ENCRYPTION_KEY does not match the data in database ${env.db.name} (${t}.${c} cannot be decrypted). Put back the key this database was encrypted with, from your separate key backup. Do NOT generate a new key: that makes every stored bank and government ID number unreadable.` };
    }
  }
  return { problem: null, checked: null }; // nothing encrypted yet (a new database)
}
