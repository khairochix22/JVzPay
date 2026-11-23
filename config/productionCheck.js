// Start-up checks of the .env settings. Pure: give it the variables (process.env), get back what is wrong.
//
//   errors   → the app refuses to start (index.js prints them and exits with code 1)
//   warnings → printed at start-up, the app still starts
//
// In production (NODE_ENV=production) every required value must be present, every secret long and not a placeholder,
// and every address HTTPS. In development only the checks that would break signing in are applied, so a laptop on
// plain http keeps working. docs/DEPLOY-AWS.md §15 lists every variable; .env.production.example explains each one.

export const MIN_SECRET_LENGTH = 32;

// The other JOHNVIVZ applications and what JVzPay needs to talk to each (team decisions 2026-11-16):
// HR is pull-only with HR's API key; CRM signs both ways (HMAC); Inventory's outbox is read with Inventory's token.
export const INTEGRATIONS = {
  hr: { label: "HR", url: "HR_API_URL", prefix: "HR_API_PREFIX", required: ["HR_API_TOKEN"], optional: ["HR_API_SECRET", "HR_INBOUND_SECRET"] },
  crm: { label: "CRM", url: "CRM_API_URL", prefix: "CRM_API_PREFIX", required: ["CRM_API_SECRET", "CRM_INBOUND_SECRET"], optional: ["CRM_API_TOKEN"] },
  inventory: { label: "Inventory", url: "INVENTORY_API_URL", prefix: "INVENTORY_API_PREFIX", required: ["INVENTORY_API_TOKEN"], optional: ["INVENTORY_API_SECRET", "INVENTORY_INBOUND_SECRET"] },
};

// values that are clearly not a real secret: placeholders from example files, words, and the old development defaults
const PLACEHOLDER = /change[_-]?me|replace[_-]?(me|this)|placeholder|example|your[_-]|^<.*>$|^x{4,}$|^(secret|password|token|test|dev|default|null|none|todo)$/i;
const KNOWN_DEFAULTS = new Set(["Password#123", "admin", "root", "jvzpay", "JVzPay"]);

const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
const falsy = (v) => ["", "0", "false", "no", "off"].includes(String(v ?? "").trim().toLowerCase());

/** TRUST_PROXY → Express "trust proxy": false (off, the default), a hop count (true = 1: one Nginx in front) or a string. */
export function parseTrustProxy(v) {
  const s = String(v ?? "").trim();
  if (falsy(s)) return false;
  if (truthy(s)) return 1;
  if (/^\d+$/.test(s)) return Number(s);
  return s; // e.g. "loopback" or "127.0.0.1"
}

export const parseBool = (v, fallback = false) => (String(v ?? "").trim() === "" ? fallback : truthy(v));

/** PENDING_INTEGRATIONS=hr,inventory → ["hr","inventory"] (applications whose servers are not ready yet). */
export const parsePending = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const isLoopback = (h) => ["127.0.0.1", "::1", "localhost"].includes(String(h ?? "").trim().toLowerCase());

/** Why `value` is not acceptable as a secret, or null when it is. */
export function secretProblem(value, min = MIN_SECRET_LENGTH) {
  const v = String(value ?? "").trim();
  if (!v) return "is empty";
  if (PLACEHOLDER.test(v) || KNOWN_DEFAULTS.has(v)) return "is a placeholder or default value";
  if (v.length < min) return `is too short (${v.length} characters; at least ${min})`;
  if (new Set(v).size < 6) return "is not random (too few different characters)";
  return null;
}

function urlProblem(value, { https }) {
  let u;
  try { u = new URL(String(value)); } catch { return "is not a valid address (example: https://johnvivz-hr.duckdns.org)"; }
  if (!["http:", "https:"].includes(u.protocol)) return "must start with https://";
  if (https && u.protocol !== "https:") return "must use https:// in production";
  if (u.username || u.password) return "must not contain a user name or password";
  return null;
}

/**
 * Checks the settings. `vars` is process.env (or a plain object in tests).
 * Returns { errors: string[], warnings: string[] }.
 */
export function checkConfig(vars = process.env) {
  const errors = [], warnings = [];
  const get = (k) => String(vars[k] ?? "").trim();
  const prod = get("NODE_ENV") === "production";
  const cookieSecure = parseBool(vars.COOKIE_SECURE);
  const trustProxy = parseTrustProxy(vars.TRUST_PROXY);
  const directTls = !!(get("HTTPS_CERT_FILE") && get("HTTPS_KEY_FILE"));

  // ---- checks for every environment: these would silently break signing in
  if (cookieSecure && trustProxy === false && !directTls) {
    errors.push("COOKIE_SECURE=true needs TRUST_PROXY=1 behind Nginx (or HTTPS_CERT_FILE/HTTPS_KEY_FILE): otherwise the app thinks every request is plain http, never sends the session cookie, and nobody can sign in.");
  }
  const base = get("PUBLIC_BASE_URL");
  if (base) {
    const p = urlProblem(base, { https: prod });
    if (p) errors.push(`PUBLIC_BASE_URL ${p}.`);
    else if (new URL(base).pathname.replace(/\/+$/, "") !== "") errors.push("PUBLIC_BASE_URL must be only the address, without a path (example: https://johnvivz-pay.duckdns.org).");
  }
  if (!prod) return { errors, warnings };

  // ---- production only
  const need = (k, why) => { if (!get(k)) errors.push(`${k} is missing: ${why}`); };
  const secret = (k, why, min) => { const p = secretProblem(vars[k], min); if (p) errors.push(`${k} ${p}: ${why}`); };

  // web server behind Nginx
  if (!base) errors.push("PUBLIC_BASE_URL is missing: password reset and registration links are built from it (example: https://johnvivz-pay.duckdns.org).");
  const host = get("HOST") || "127.0.0.1";
  if (!isLoopback(host)) errors.push(`HOST=${host}: behind Nginx the app must listen on 127.0.0.1 only, so nobody can bypass Nginx (and its /api/integration/ address list) by calling port ${get("PORT") || 3002} directly.`);
  if (directTls) errors.push("HTTPS_CERT_FILE and HTTPS_KEY_FILE must stay empty: Nginx does HTTPS (Let's Encrypt) and talks to the app over plain http on 127.0.0.1.");
  if (trustProxy === false) warnings.push("TRUST_PROXY is off: behind Nginx every visitor looks like 127.0.0.1, so sign-in limits are shared by everyone and audit logs show no real addresses. Set TRUST_PROXY=1.");
  else if (trustProxy !== 1) warnings.push(`TRUST_PROXY=${vars.TRUST_PROXY}: with exactly one Nginx in front use TRUST_PROXY=1.`);
  if (!cookieSecure) warnings.push("COOKIE_SECURE is off: set COOKIE_SECURE=true as soon as https:// works (certbot), so the session cookie is never sent over plain http.");

  // database
  need("DB_HOST", "the MySQL server (127.0.0.1 on the same EC2 instance).");
  need("DB_NAME", "the database name, exactly JVzPay (Linux MySQL is case-sensitive).");
  if (get("DB_NAME") && get("DB_NAME") !== "JVzPay") warnings.push(`DB_NAME=${get("DB_NAME")}: the documentation, backups and grants use JVzPay (case-sensitive on Linux).`);
  need("DB_USER", "the MySQL user that has access only to the JVzPay database.");
  if (get("DB_USER").toLowerCase() === "root") errors.push("DB_USER=root: in production use the jvzpay MySQL user that can reach only the JVzPay database (docs/DEPLOY-AWS.md §4).");
  secret("DB_PASSWORD", "the jvzpay MySQL user's password (openssl rand -base64 24).", 16);

  // secrets of this application
  secret("SESSION_SECRET", "signs the sign-in cookies (openssl rand -hex 48).", 64);
  const key = get("DATA_ENCRYPTION_KEY");
  if (!key) errors.push("DATA_ENCRYPTION_KEY is missing: it encrypts bank account and government ID numbers. Put back the key this database was encrypted with (from your separate key backup), or for a brand-new database generate one with: openssl rand -hex 32");
  else if (!/^[0-9a-fA-F]{64}$/.test(key)) errors.push("DATA_ENCRYPTION_KEY must be exactly 64 hex characters (openssl rand -hex 32).");
  else if (new Set(key.toLowerCase()).size < 8) errors.push("DATA_ENCRYPTION_KEY is not random: generate it with openssl rand -hex 32.");
  if (get("AUDIT_SEAL_KEY")) secret("AUDIT_SEAL_KEY", "seals the audit trail (optional; openssl rand -hex 32).");

  // the other applications
  const pending = parsePending(vars.PENDING_INTEGRATIONS);
  for (const p of pending) if (!INTEGRATIONS[p]) errors.push(`PENDING_INTEGRATIONS: "${p}" is not one of hr, crm, inventory.`);
  for (const [code, app] of Object.entries(INTEGRATIONS)) {
    const isPending = pending.includes(code);
    if (isPending) warnings.push(`PENDING_INTEGRATIONS: ${app.label} is not checked yet. Fill in its settings and remove "${code}" from PENDING_INTEGRATIONS as soon as ${app.label}'s server is ready.`);
    if (!isPending || get(app.url)) {
      if (!get(app.url)) errors.push(`${app.url} is missing: ${app.label}'s address (or put "${code}" in PENDING_INTEGRATIONS until ${app.label}'s server is ready).`);
      else { const p = urlProblem(get(app.url), { https: true }); if (p) errors.push(`${app.url} ${p}.`); else if (new URL(get(app.url)).pathname.replace(/\/+$/, "")) errors.push(`${app.url} must be only the address; the API path goes in ${app.prefix}.`); }
      if (!get(app.prefix)) errors.push(`${app.prefix} is missing: the API path ${app.label} serves (/api/integration/v1).`);
      if (!isPending) for (const k of app.required) secret(k, `given by ${app.label}'s team or agreed with them (see .env.production.example).`);
    }
    for (const k of app.optional) if (get(k)) secret(k, "optional, but when set it must be a real secret.");
  }

  // a secret must never be reused for another application or direction
  const secretKeys = ["SESSION_SECRET", "DATA_ENCRYPTION_KEY", "AUDIT_SEAL_KEY", "DB_PASSWORD", ...Object.values(INTEGRATIONS).flatMap((a) => [...a.required, ...a.optional])];
  const seen = new Map();
  for (const k of secretKeys) {
    const v = get(k);
    if (!v) continue;
    if (seen.has(v)) errors.push(`${k} has the same value as ${seen.get(v)}: every secret and token must be different (one per application and per direction).`);
    else seen.set(v, k);
  }

  if (get("ADMIN_PASSWORD")) warnings.push("ADMIN_PASSWORD is still in .env: it is needed only once by npm run seed. Remove it now.");
  if (get("DISABLE_SCHEDULER") === "1") warnings.push("DISABLE_SCHEDULER=1: payroll computation, HR sync, Inventory polling, event delivery, audit sealing and daily backups are OFF.");
  return { errors, warnings };
}
