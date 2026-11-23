// Behind Nginx (docs/DEPLOY-AWS.md): the runner starts this server with TRUST_PROXY=1, COOKIE_SECURE=true,
// PUBLIC_BASE_URL=https://johnvivz-pay.duckdns.org and HOST=127.0.0.1, and every request here carries the headers Nginx
// adds (X-Forwarded-For, X-Forwarded-Proto). Checks: public /health, secure cookies, real client addresses, links from
// PUBLIC_BASE_URL, and signed requests verified on the exact raw body and path + query string.
import crypto from "node:crypto";
import { Client, check, report, db, root } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, sequelize } = db;
const PUBLIC = "https://johnvivz-pay.duckdns.org";

// a browser coming through Nginx: https at Nginx, plain http from Nginx to the app
class ViaNginx extends Client {
  constructor(url, ip) { super(url); this.ip = ip; }
  req(method, path, body, headers = {}) {
    return super.req(method, path, body, { "x-forwarded-proto": "https", "x-forwarded-for": this.ip, "x-forwarded-host": "evil.example", ...headers });
  }
}

// ---- health checks
let r = await fetch(`${base}/health`);
let body = await r.json().catch(() => null);
check("GET /health is public and answers only {status: ok}", r.status === 200 && JSON.stringify(body) === '{"status":"ok"}', JSON.stringify(body));
check("GET /health sets no cookie and is not cached", !r.headers.get("set-cookie") && /no-store/.test(r.headers.get("cache-control") || ""));
r = await fetch(`${base}/healthz`);
body = await r.json().catch(() => null);
check("GET /healthz still answers, with the database check", r.status === 200 && body?.database === "ok", JSON.stringify(body));
r = await fetch(`${base}/api/integration/v1/health`);
check("signed /api/integration/v1/health still refuses an unsigned caller", r.status === 401);

// ---- secure cookie: only when the request came over https (X-Forwarded-Proto from Nginx)
r = await fetch(`${base}/login`, { redirect: "manual" });
check("COOKIE_SECURE: no session cookie over plain http", !(r.headers.getSetCookie?.() || []).some((c) => c.startsWith("jvzpay.sid=")));
r = await fetch(`${base}/login`, { redirect: "manual", headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.70" } });
const sid = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith("jvzpay.sid=")) || "";
check("COOKIE_SECURE: the session cookie is Secure, HttpOnly, SameSite=Lax over https", /;\s*Secure/i.test(sid) && /HttpOnly/i.test(sid) && /SameSite=Lax/i.test(sid), sid);
check("helmet asks browsers to upgrade insecure requests", /upgrade-insecure-requests/.test(r.headers.get("content-security-policy") || ""));

// ---- the visitor's real address (TRUST_PROXY=1)
const admin = new ViaNginx(base, "203.0.113.77");
r = await admin.login("admin@johnvivz.local", "Ledger2026xyz");
check("sign-in works through the proxy with a secure cookie", r.status === 302 && r.loc === "/dashboard", `${r.status} ${r.loc}`);
let u = await selectOne("SELECT id, last_login_ip FROM users WHERE email = 'admin@johnvivz.local'");
check("the sign-in records the visitor's address from X-Forwarded-For", u.last_login_ip === "203.0.113.77", u.last_login_ip);
const audit = await selectOne("SELECT ip_address FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1", [u.id]);
check("the audit log records the visitor's address", audit?.ip_address === "203.0.113.77", audit?.ip_address);
// one hop trusted: an address the caller put in front of Nginx's own entry is ignored
const spoof = new ViaNginx(base, "198.51.100.1, 203.0.113.88");
await spoof.login("admin@johnvivz.local", "Ledger2026xyz");
u = await selectOne("SELECT last_login_ip FROM users WHERE email = 'admin@johnvivz.local'");
check("only the address Nginx added counts (a faked X-Forwarded-For entry is ignored)", u.last_login_ip === "203.0.113.88", u.last_login_ip);

// ---- links handed to people come from PUBLIC_BASE_URL, never from the request's Host / X-Forwarded-Host
const carla = await selectOne("SELECT id FROM users WHERE email = 'carla@johnvivz.local'");
await admin.submit(`/users/${carla.id}/edit`, `/users/${carla.id}/reset-link`, {});
r = await admin.get(`/users/${carla.id}/edit`);
const link = (r.text.match(/https?:\/\/[^\s<"]+\/reset-password\/[A-Za-z0-9_-]+/) || [])[0] || "";
check("the password reset link starts with PUBLIC_BASE_URL", link.startsWith(`${PUBLIC}/reset-password/`), link || r.text.slice(0, 200));
check("the reset link does not use the Host or X-Forwarded-Host header", !/127\.0\.0\.1|localhost|evil\.example/.test(link), link);
if (link) {
  r = await new ViaNginx(base, "203.0.113.90").get(link.slice(PUBLIC.length));
  check("the reset link opens its page", r.status === 200 && /Choose a new password/i.test(r.text), String(r.status));
}
r = await admin.get("/users/registrations");
check("the employee registration link is built from PUBLIC_BASE_URL", r.status === 200 && r.text.includes(`${PUBLIC}/register/employee`));

// ---- signed requests through Nginx: the exact raw body and the original path + query string
const { computeSignature, manilaTimestamp } = await import(root + "lib/serviceSignature.js");
const secret = process.env.CRM_INBOUND_SECRET;
const signedPost = async (path, raw, { signPath = path, signBody = raw } = {}) => {
  const ts = manilaTimestamp();
  const x = await fetch(`${base}${path}`, {
    method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20", "x-forwarded-proto": "https", "X-JVZ-Client": "johnvivz_crm", "X-JVZ-Timestamp": ts, "X-JVZ-Signature": computeSignature(secret, "POST", signPath, ts, signBody) },
  });
  return { status: x.status, body: await x.json().catch(() => ({})) };
};
// unusual spacing, key order and a non-ASCII character: re-serialising the JSON would change these bytes
const raw = '{"z":1,   "a" : "Piña\\u00f1",\n "list":[3,1,2]}';
const path = "/api/integration/v1/test/echo?b=2&a=1&note=x%20y";
r = await signedPost(path, raw);
check("a signed POST with a query string is accepted through the proxy", r.status === 200 && r.body.status === "ok" && r.body.signed === true, JSON.stringify(r.body));
check("the app saw the path + query string exactly as sent", r.body.path === path, r.body.path);
check("the signature was checked on the exact raw body bytes", r.body.body_sha256 === crypto.createHash("sha256").update(raw).digest("hex"));
r = await signedPost(path, raw, { signPath: "/api/integration/v1/test/echo?a=1&b=2&note=x%20y" });
check("signing a reordered query string is refused (the original one counts)", r.status === 401 && r.body.error === "invalid_signature", JSON.stringify(r.body));
r = await signedPost(path, raw.replace("   ", "  "), { signBody: raw });
check("a body changed by one byte (same JSON meaning) is refused", r.status === 401 && r.body.error === "invalid_signature", JSON.stringify(r.body));

report();
await sequelize.close();
