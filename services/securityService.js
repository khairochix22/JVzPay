// Security monitoring: sign-in history, system health, audit-trail verification, and page print logging.
import fs from "node:fs";
import { select, scalar, selectOne } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyPermission } from "../lib/notify.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { sealPending, verifyAuditTrail } from "../lib/auditSeal.js";
import { BACKUP_DIR } from "../lib/mysqlTools.js";

export const SIGN_IN_EVENTS = {
  login: ["login"], logout: ["logout"],
  failed: ["login_failed", "login_blocked_locked", "login_blocked_inactive", "account_locked"],
  password: ["password_changed", "password_reset_link_created", "password_reset_completed", "password_reset_by_admin"],
};
const ALL_EVENTS = Object.values(SIGN_IN_EVENTS).flat();

export async function signInHistory(req) {
  const t = tableState(req, { sortable: { time: "a.id" }, defaultSort: "time", defaultDir: "desc", perPage: 25 });
  const type = Object.hasOwn(SIGN_IN_EVENTS, req.query.type) ? req.query.type : "";
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : "";
  const events = type ? SIGN_IN_EVENTS[type] : ALL_EVENTS;
  const where = [`a.action IN (${events.map(() => "?").join(",")})`], params = [...events];
  if (from) { where.push("a.created_at >= ?"); params.push(`${from} 00:00:00`); }
  if (to) { where.push("a.created_at <= ?"); params.push(`${to} 23:59:59`); }
  if (t.q) { const l = likeTerm(t.q); where.push("(a.user_name LIKE ? OR a.ip_address LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(a.new_value, '$.email')) LIKE ?)"); params.push(l, l, l); }
  const W = `WHERE ${where.join(" AND ")}`;
  const total = Number(await scalar(`SELECT COUNT(*) FROM audit_logs a ${W}`, params));
  const rows = (await select(`SELECT a.id, a.action, a.user_name, a.user_role, a.ip_address, a.user_agent, a.new_value, a.created_at FROM audit_logs a ${W} ORDER BY ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, params))
    .map((r) => {
      const nv = typeof r.new_value === "string" ? JSON.parse(r.new_value || "null") : r.new_value;
      const ua = String(r.user_agent || "");
      const device = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : ua ? "Other" : "—";
      const kind = Object.entries(SIGN_IN_EVENTS).find(([, list]) => list.includes(r.action))?.[0];
      return { ...r, email: nv?.email || "", device: /Mobile|Android|iPhone/.test(ua) ? `${device} (mobile)` : device, kind };
    });
  return { rows, t, type, from, to, meta: tableMeta(req, t, total, { type, from, to }) };
}

export async function systemHealth() {
  const t0 = Date.now();
  await scalar("SELECT 1");
  const dbMs = Date.now() - t0;
  const [lastBackup, lastFailure, lastVerify, unsealed, sealed] = await Promise.all([
    selectOne("SELECT created_at, remarks FROM audit_logs WHERE action = 'backup_created' AND user_role = 'system' ORDER BY id DESC LIMIT 1"),
    selectOne("SELECT created_at, remarks FROM audit_logs WHERE action = 'backup_failed' ORDER BY id DESC LIMIT 1"),
    selectOne("SELECT created_at, remarks, decision FROM audit_logs WHERE action = 'audit_verified' ORDER BY id DESC LIMIT 1"),
    scalar("SELECT COUNT(*) FROM audit_logs WHERE seal_seq IS NULL"),
    scalar("SELECT COUNT(*) FROM audit_logs WHERE seal_seq IS NOT NULL"),
  ]);
  let diskFreeGb = null;
  try { const s = fs.statfsSync(fs.existsSync(BACKUP_DIR) ? BACKUP_DIR : process.cwd()); diskFreeGb = Math.round((s.bavail * s.bsize) / 1073741824 * 10) / 10; } catch { /* not supported on this system */ }
  return {
    uptimeHours: Math.round(process.uptime() / 360) / 10, dbMs, diskFreeGb,
    lastBackup, lastFailure: lastFailure && (!lastBackup || lastFailure.created_at > lastBackup.created_at) ? lastFailure : null,
    lastVerify, unsealed: Number(unsealed), sealed: Number(sealed), schedulerOn: process.env.DISABLE_SCHEDULER !== "1",
  };
}

/** Seals anything pending, then checks the whole chain. A broken chain also alerts everyone who manages settings. */
export async function verifyAuditNow(req) {
  await sealPending();
  const result = await verifyAuditTrail();
  await audit(req, { action: "audit_verified", module: "audit", decision: result.ok ? "approved" : "rejected",
    remarks: result.ok ? `${result.checked} sealed records verified; ${result.unsealed} waiting to be sealed.` : result.problem });
  if (!result.ok) {
    await notifyPermission("settings.manage", { type: "audit_tampered", title: "Audit trail check failed", message: result.problem, link: "/settings/security" });
  }
  return result;
}

const MODULE_BY_PATH = [[/^\/reports/, "reports"], [/payslip/, "payslips"], [/^\/payroll/, "payroll"], [/^\/accounting/, "accounting"], [/^\/attendance|^\/my\/attendance/, "attendance"], [/^\/analytics/, "analytics"]];

export async function logPrint(req) {
  const page = String(req.body.page || "").slice(0, 300);
  if (!page.startsWith("/")) return;
  const module = MODULE_BY_PATH.find(([re]) => re.test(page))?.[1] || "general";
  await audit(req, { action: "page_printed", module, recordType: "page", recordId: page.split("?")[0].slice(0, 40), remarks: `${String(req.body.title || "").slice(0, 120)} · ${page}`.slice(0, 500) });
}
