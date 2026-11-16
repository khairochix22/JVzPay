// Signed service requests between the JOHNVIVZ applications (CRM integration contract v0.4.1 §2).
//
//   X-JVZ-Client:    johnvivz_crm | johnvivz_hr | johnvivz_inventory | johnvivz_accounting   (the sender)
//   X-JVZ-Timestamp: 2026-11-13T09:30:00.000+08:00
//   X-JVZ-Signature: hex(HMAC_SHA256(secret, METHOD + "\n" + path + "\n" + timestamp + "\n" + sha256hex(body)))
//
// `path` is the request target exactly as sent (path + query string); `body` is the raw request body ("" when none).
// A request more than MAX_SKEW_SECONDS from our clock is refused, and so is a signature already accepted (replay).
// Pure functions plus one in-memory replay guard; no database.
import crypto from "node:crypto";

export const MAX_SKEW_SECONDS = 300;
export const SELF_CLIENT = "johnvivz_accounting";

const sha256hex = (buf) => crypto.createHash("sha256").update(buf ?? "").digest("hex");

export function computeSignature(secret, method, path, timestamp, body = "") {
  const payload = `${String(method).toUpperCase()}\n${path}\n${timestamp}\n${sha256hex(body)}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/** ISO-8601 in Philippine time with its offset, e.g. 2026-11-13T09:30:00.000+08:00. */
export function manilaTimestamp(date = new Date()) {
  const local = new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 23);
  return `${local}+08:00`;
}

/** Headers for a request JVzPay sends. Sign every attempt anew (a retry gets a new timestamp). */
export function signedHeaders(secret, method, path, body = "", now = new Date()) {
  const timestamp = manilaTimestamp(now);
  return {
    "X-JVZ-Client": SELF_CLIENT,
    "X-JVZ-Timestamp": timestamp,
    "X-JVZ-Signature": computeSignature(secret, method, path, timestamp, body),
  };
}

/** Remembers accepted signatures for the skew window, so the same signed request cannot be replayed. */
export class ReplayGuard {
  constructor(windowMs = MAX_SKEW_SECONDS * 2 * 1000) { this.windowMs = windowMs; this.seen = new Map(); }
  /** true the first time a signature is seen inside the window, false on a replay. */
  accept(signature, nowMs = Date.now()) {
    for (const [sig, at] of this.seen) if (nowMs - at > this.windowMs) this.seen.delete(sig); else break;
    if (this.seen.has(signature)) return false;
    this.seen.set(signature, nowMs);
    return true;
  }
}

/**
 * Checks a signed request. Returns null when valid, otherwise the contract's error code:
 * "unauthorized" (missing headers / unknown client), "stale_timestamp", "invalid_signature" or "replayed_request".
 * `secretFor(client)` returns the shared secret for that sender, or "" when the sender is not configured.
 */
export function verifySignedRequest({ client, timestamp, signature, method, path, body, secretFor, guard, nowMs = Date.now(), maxSkewSeconds = MAX_SKEW_SECONDS }) {
  if (!client || !timestamp || !signature) return "unauthorized";
  const secret = secretFor(client);
  if (!secret) return "unauthorized";
  const at = Date.parse(timestamp);
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(timestamp) || Number.isNaN(at)) return "stale_timestamp";
  if (Math.abs(nowMs - at) > maxSkewSeconds * 1000) return "stale_timestamp";
  const expected = computeSignature(secret, method, path, timestamp, body);
  const given = String(signature).toLowerCase();
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return "invalid_signature";
  if (guard && !guard.accept(expected, nowMs)) return "replayed_request";
  return null;
}
