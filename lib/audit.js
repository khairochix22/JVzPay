import { exec } from "./db.js";

// Keys that must never reach the audit trail in clear text.
const SENSITIVE = /(password|passwd|secret|token|account_number|_enc$|sss_no|philhealth_no|pagibig_no|^tin$)/i;

export function redact(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? "[REDACTED]" : redact(v);
    return out;
  }
  return value;
}

const j = (v) => (v === null || v === undefined ? null : JSON.stringify(redact(v)));

/**
 * Append an audit record. `actor` is req.user (or null for system actions).
 * Pass `trx` to make the audit row part of the business transaction.
 */
export async function audit(req, entry, trx = null) {
  const actor = req?.user || entry.actor || null;
  await exec(
    `INSERT INTO audit_logs
       (user_id, user_name, user_role, action, module, record_type, record_id, previous_value, new_value,
        decision, remarks, ip_address, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      actor?.id ?? null,
      actor?.full_name ?? null,
      actor?.role_code ?? null,
      entry.action,
      entry.module,
      entry.recordType ?? null,
      entry.recordId != null ? String(entry.recordId) : null,
      j(entry.previous),
      j(entry.next),
      entry.decision ?? null,
      entry.remarks ? String(entry.remarks).slice(0, 500) : null,
      req?.ip ? String(req.ip).slice(0, 45) : null,
      req?.get ? (req.get("user-agent") || "").slice(0, 255) : null,
    ],
    trx
  );
}
