// Tamper-evident audit trail. Every audit record is sealed once, in order, with an HMAC that includes the previous seal,
// so changing or removing any sealed record (even directly in MySQL) breaks the chain and "Verify" reports where.
// The key never leaves the server: AUDIT_SEAL_KEY if set, otherwise derived from DATA_ENCRYPTION_KEY.
import crypto from "node:crypto";
import { select, selectOne, scalar, exec, tx } from "./db.js";
import { env } from "../config/env.js";

const GENESIS = "0".repeat(64);
const key = () => crypto.createHmac("sha256", process.env.AUDIT_SEAL_KEY || env.dataKey).update("jvzpay-audit-seal-v1").digest();
const asJson = (v) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
const asTime = (v) => (v instanceof Date ? v.toISOString() : String(v));

function canonical(r) {
  return JSON.stringify([
    String(r.id), r.user_id === null ? null : String(r.user_id), r.user_name, r.user_role, r.action, r.module, r.record_type, r.record_id,
    asJson(r.previous_value), asJson(r.new_value), r.decision, r.remarks, r.ip_address, r.user_agent, asTime(r.created_at),
  ]);
}
const seal = (k, prev, row) => crypto.createHmac("sha256", k).update(prev).update(canonical(row)).digest("hex");

let running = false;

/** Seals every record not sealed yet. Safe to call often; only one sealer runs at a time across app instances. */
export async function sealPending(batch = 500) {
  if (running) return 0;
  running = true;
  try {
    return await tx(async (trx) => {
      if (Number(await scalar("SELECT GET_LOCK('jvzpay_audit_seal', 0)", [], trx)) !== 1) return 0;
      try {
        const k = key();
        let sealed = 0;
        for (;;) {
          const last = await selectOne("SELECT seal_seq, seal_hash FROM audit_logs WHERE seal_seq IS NOT NULL ORDER BY seal_seq DESC LIMIT 1", [], trx);
          const rows = await select("SELECT * FROM audit_logs WHERE seal_seq IS NULL ORDER BY id LIMIT ?", [batch], trx);
          if (!rows.length) break;
          let seq = Number(last?.seal_seq || 0), prev = last?.seal_hash || GENESIS;
          for (const r of rows) {
            seq += 1;
            prev = seal(k, prev, r);
            await exec("UPDATE audit_logs SET seal_seq = ?, seal_hash = ? WHERE id = ? AND seal_seq IS NULL", [seq, prev, r.id], trx);
            sealed += 1;
          }
          if (rows.length < batch) break;
        }
        return sealed;
      } finally {
        await scalar("SELECT RELEASE_LOCK('jvzpay_audit_seal')", [], trx);
      }
    });
  } finally {
    running = false;
  }
}

/** Recomputes the whole chain. Returns { ok, checked, unsealed } or the first problem found. */
export async function verifyAuditTrail() {
  const k = key();
  let prev = GENESIS, expected = 1, checked = 0;
  for (;;) {
    const rows = await select("SELECT * FROM audit_logs WHERE seal_seq >= ? ORDER BY seal_seq LIMIT 1000", [expected]);
    if (!rows.length) break;
    for (const r of rows) {
      if (Number(r.seal_seq) !== expected) return { ok: false, checked, recordId: null, problem: `Sealed record number ${expected} is missing: a record was removed.` };
      prev = seal(k, prev, r);
      if (prev !== r.seal_hash) return { ok: false, checked, recordId: r.id, problem: `Audit record ${r.id} was changed after it was sealed.` };
      expected += 1;
      checked += 1;
    }
  }
  const unsealed = Number(await scalar("SELECT COUNT(*) FROM audit_logs WHERE seal_seq IS NULL"));
  return { ok: true, checked, unsealed };
}
