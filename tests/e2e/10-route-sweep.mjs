// Walks every route Express actually registered and requests it as each role.
// GETs use id 1 so real pages render; POSTs use id 999999 so an allowed request cannot change a record.
import { Client } from "./lib.mjs";
const root = new URL("../../", import.meta.url).href;
const router = (await import(root + "routes/index.js")).default;
const base = process.argv[2];

function mountOf(layer) {
  if (layer.path) return layer.path;
  const src = layer.regexp?.source || "";
  const m = /^\^((?:\\\/[\w-]+)+)\\\/\?\(\?=/.exec(src);
  return m ? m[1].replace(/\\\//g, "/") : "";
}
function walk(stack, prefix, out) {
  for (const l of stack) {
    if (l.route) {
      const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path];
      for (const p of paths) for (const [m, on] of Object.entries(l.route.methods)) if (on) out.push({ method: m.toUpperCase(), path: (prefix + p).replace(/\/$/, "") || "/" });
    } else if (l.name === "router" && l.handle?.stack) walk(l.handle.stack, prefix + mountOf(l), out);
  }
  return out;
}
const seen = new Set();
const routes = walk(router.stack, "", []).filter((r) => { const k = r.method + r.path; if (seen.has(k)) return false; seen.add(k); return true; });
const fill = (p, id) => p.replace(/:(\w+)\(?[^/]*\)?/g, (_, n) => (n === "name" || n === "file" || n === "code" ? "zzz" : n === "kind" ? "statutory" : id));

const PUBLIC = new Set(["/", "/login", "/privacy", "/register", "/register/sent", "/register/employee", "/register/employee/done", "/reset-password/:token", "/forgot-password", "/reset-password", "/healthz"]);
const SKIP_POST = /^\/(logout|login|register|forgot-password|reset-password|change-password)/;
const users = { maria: "maria@johnvivz.local", paolo: "paolo@johnvivz.local", grace: "grace@johnvivz.local", admin: "admin@johnvivz.local" };
const clients = {};
for (const [k, email] of Object.entries(users)) { clients[k] = new Client(base); await clients[k].login(email, k === "admin" ? "Ledger2026xyz" : "Welcome2026ok"); }

let bad = 0;
const flag = (msg) => { bad++; console.log("PROBLEM  " + msg); };
const gets = routes.filter((r) => r.method === "GET"), posts = routes.filter((r) => r.method === "POST");
console.log(`routes: ${gets.length} GET, ${posts.length} POST`);

// anonymous visitors reach nothing but the public pages
const anon = new Client(base);
for (const r of gets) {
  if (PUBLIC.has(r.path)) continue;
  const res = await anon.get(fill(r.path, 1));
  if (!(res.status === 302 || res.status === 303)) flag(`anonymous GET ${r.path} → ${res.status}`);
}
const anonToken = await anon.csrf("/login");
for (const r of posts) {
  if (SKIP_POST.test(r.path)) continue;
  const res = await anon.post(fill(r.path, 999999), { _csrf: anonToken });
  if (![302, 303, 401, 403].includes(res.status)) flag(`anonymous POST ${r.path} → ${res.status}`); // 401: script endpoints
  if (res.status === 200) flag(`anonymous POST ${r.path} rendered a page`);
}

// forged POSTs without a token are refused for a signed-in user
for (const r of posts) {
  if (SKIP_POST.test(r.path)) continue;
  const res = await clients.admin.post(fill(r.path, 999999), {});
  if (res.status !== 403) flag(`POST ${r.path} accepted without a CSRF token → ${res.status}`);
}

// who can reach what; any 5xx is a defect
const allowed = { maria: [], paolo: [], grace: [], admin: [] };
const timings = [];
for (const k of Object.keys(clients)) {
  for (const r of gets) {
    if (r.path === "/logout") continue;
    const t0 = performance.now();
    const res = await clients[k].get(fill(r.path, 1));
    timings.push([Math.round(performance.now() - t0), k, r.path]);
    if (res.status >= 500) flag(`${k} GET ${r.path} → ${res.status}`);
    if (res.status === 200) {
      allowed[k].push(r.path);
      const broken = /value="—"|width:NaN|\bNaN\b|\[object Object\]|>undefined<|="undefined"|Invalid Date/.exec(res.text || "");
      if (broken) flag(`${k} GET ${r.path} rendered a broken value: ${res.text.slice(Math.max(0, broken.index - 60), broken.index + 30).replace(/\s+/g, " ")}`);
    }
  }
}
console.log("\nslowest pages (ms): " + timings.sort((a, b) => b[0] - a[0]).slice(0, 6).map((t) => `${t[0]} ${t[1]} ${t[2]}`).join(" | "));
console.log("\nemployee can open:\n  " + allowed.maria.join("\n  "));
const emp = allowed.maria.filter((p) => !/^\/(my|notifications|dashboard|account|profile|change-password|documents|privacy)/.test(p) && !PUBLIC.has(p));
if (emp.length) flag("employee reached staff pages: " + emp.join(", "));

// POST permissions: only self-service is open to an employee
const postOpen = { maria: [], paolo: [], grace: [] };
for (const k of Object.keys(postOpen)) {
  const t = await clients[k].csrf("/dashboard");
  for (const r of posts) {
    if (SKIP_POST.test(r.path)) continue;
    const res = await clients[k].post(fill(r.path, 999999), { _csrf: t });
    if (res.status >= 500) flag(`${k} POST ${r.path} → ${res.status}`);
    if (res.status !== 403) postOpen[k].push(r.path);
  }
}
const empPost = postOpen.maria.filter((p) => !/^\/(my|notifications|account|privacy|session|activity)/.test(p));
if (empPost.length) flag("employee can POST to: " + empPost.join(", "));
console.log("\nstaff can POST to:\n  " + postOpen.paolo.join("\n  "));
console.log("\nsupervisor can POST to:\n  " + postOpen.grace.join("\n  "));
// Payroll Staff activate Self-Service accounts by design (master prompt §IV), decide employees' requests and release
// salary loans (owner, 2026-11-13); payroll batches, settings, roles and users stay with the supervisor
const staffApprove = postOpen.paolo.filter((p) => /approve|finalize|release|reject|void|verify|\/decide|settings|roles|users/.test(p) && !p.startsWith("/payroll/loans/"));
if (staffApprove.length) flag("staff can reach approval routes: " + staffApprove.join(", "));
console.log(`\n${bad} problem(s)`);
process.exit(0);
