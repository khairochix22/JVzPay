// System administration (Modules 10–11): announcements, settings, role permissions, security monitoring, database backups.
import fs from "node:fs";
import path from "node:path";
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { BACKUP_DIR, BACKUP_NAME, dumpDatabase, newBackupName } from "../lib/mysqlTools.js";
import { audit } from "../lib/audit.js";
import { notifyMany, notifyPermission } from "../lib/notify.js";
import { clearSettingsCache, getSetting } from "../lib/settings.js";
import { clearPermissionCache } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { badRequest, notFound } from "../lib/errors.js";
import { Announcement } from "../models/index.js";

export { BACKUP_DIR };

// ---- announcements --------------------------------------------------------------------------------------------------------------
export const listAnnouncements = () => select(`SELECT a.*, u.full_name AS published_by_name FROM announcements a JOIN users u ON u.id = a.published_by ORDER BY a.id DESC LIMIT 100`);

export async function publishAnnouncement(req, v) {
  return tx(async (trx) => {
    const { insertId } = await exec("INSERT INTO announcements (title, body, audience, published_by, expires_at) VALUES (?,?,?,?,?)", [v.title, v.body, v.audience, req.user.id, v.expires_at ? `${v.expires_at} 23:59:59` : null], trx);
    const roleFilter = v.audience === "employees" ? "AND r.code = 'employee'" : v.audience === "staff" ? "AND r.code <> 'employee'" : "";
    const users = await select(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status = 'active' AND u.deleted_at IS NULL ${roleFilter}`, [], trx);
    await notifyMany(users.map((u) => u.id).filter((id) => id !== req.user.id), { type: "announcement", title: v.title, message: v.body.slice(0, 500), relatedType: "announcement", relatedId: insertId }, trx);
    await audit(req, { action: "announcement_published", module: "settings", recordType: "announcement", recordId: insertId, next: { title: v.title, audience: v.audience, recipients: users.length } }, trx);
    return users.length;
  });
}

export async function withdrawAnnouncement(req, id) {
  const a = await Announcement.findByPk(id);
  if (!a) throw notFound("Announcement not found.");
  await a.update({ is_active: false });
  await audit(req, { action: "announcement_withdrawn", module: "settings", recordType: "announcement", recordId: id, remarks: a.title });
  return a;
}

// ---- system settings --------------------------------------------------------------------------------------------------------------
export async function groupedSettings() {
  const rows = await select("SELECT * FROM system_settings ORDER BY group_name, setting_key");
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.group_name)) groups.set(r.group_name, []); groups.get(r.group_name).push({ ...r, field: r.setting_key.replace(/\./g, "__"), isBool: r.value_type === "boolean", isOn: ["1", "true", "yes", "on"].includes(String(r.setting_value).toLowerCase()), isTime: r.value_type === "time", isNumber: r.value_type === "number", isSchedule: r.setting_key === "payroll.contribution_schedule" }); }
  return [...groups].map(([name, items]) => ({ name, items }));
}

function checkSetting(s, raw) {
  const v = String(raw ?? "").trim();
  switch (s.value_type) {
    case "boolean": return ["1", "on", "true"].includes(v.toLowerCase()) ? "1" : "0";
    case "number":
      if (!v && s.setting_key === "attendance.rest_day_2") return ""; // blank = a six-day week with one day off
      if (!/^-?\d+(\.\d+)?$/.test(v)) throw badRequest(`${s.description || s.setting_key}: enter a number.`); return v;
    case "time": if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw badRequest(`${s.description || s.setting_key}: enter a valid time.`); return v;
    default:
      if (!v && s.group_name !== "privacy") throw badRequest(`${s.description || s.setting_key} cannot be empty.`);
      if (s.setting_key === "payroll.contribution_schedule" && !["split", "last"].includes(v)) throw badRequest("Contribution schedule must be split or last.");
      return v.slice(0, 500);
  }
}

export async function saveSettings(req, body) {
  const rows = await select("SELECT * FROM system_settings");
  const changes = [];
  for (const s of rows) {
    const field = s.setting_key.replace(/\./g, "__");
    if (s.value_type !== "boolean" && !(field in body)) continue;
    const next = checkSetting(s, body[field]);
    if (String(s.setting_value) !== next) changes.push({ key: s.setting_key, from: s.setting_value, to: next });
  }
  const rest = changes.find((c) => c.key === "attendance.rest_day");
  if (rest && !(Number(rest.to) >= 0 && Number(rest.to) <= 6)) throw badRequest("The rest day must be between 0 (Sunday) and 6 (Saturday).");
  const current = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  const after = (k) => (changes.find((c) => c.key === k) || { to: current[k] }).to;
  const rest2 = after("attendance.rest_day_2");
  if (rest2 !== undefined && rest2 !== null && rest2 !== "") {
    if (!(Number.isInteger(Number(rest2)) && Number(rest2) >= 0 && Number(rest2) <= 6)) throw badRequest("The second day off must be between 0 (Sunday) and 6 (Saturday), or blank.");
    if (String(rest2) === String(after("attendance.rest_day"))) throw badRequest("The two default days off must be different days.");
  }
  const keep = changes.find((c) => c.key === "backup.keep_days");
  if (keep && !(Number.isInteger(Number(keep.to)) && Number(keep.to) >= 1 && Number(keep.to) <= 365)) throw badRequest("Keep backups for 1 to 365 days.");
  const dpy = changes.find((c) => c.key === "payroll.days_per_year");
  if (dpy && !(Number(dpy.to) >= 200 && Number(dpy.to) <= 366)) throw badRequest("Days per year must be between 200 and 366.");
  await tx(async (trx) => {
    for (const c of changes) await exec("UPDATE system_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?", [c.to, req.user.id, c.key], trx);
    if (changes.length) await audit(req, { action: "settings_updated", module: "settings", recordType: "system_settings", previous: Object.fromEntries(changes.map((c) => [c.key, c.from])), next: Object.fromEntries(changes.map((c) => [c.key, c.to])) }, trx);
  });
  clearSettingsCache();
  return changes.length;
}

// ---- roles & permissions --------------------------------------------------------------------------------------------------------------
export async function permissionMatrix() {
  const [roles, permissions, grants] = await Promise.all([
    select("SELECT * FROM roles ORDER BY FIELD(code,'accounting_supervisor','accounting_staff','payroll_staff','employee')"),
    select("SELECT * FROM permissions ORDER BY module, code"),
    select("SELECT role_id, permission_id FROM role_permissions"),
  ]);
  const has = new Set(grants.map((g) => `${g.role_id}:${g.permission_id}`));
  const modules = new Map();
  for (const p of permissions) { if (!modules.has(p.module)) modules.set(p.module, []); modules.get(p.module).push({ ...p, cells: roles.map((r) => ({ role: r.id, roleName: r.name, on: has.has(`${r.id}:${p.id}`), name: `r${r.id}[p${p.id}]` })) }); }
  return { roles, modules: [...modules].map(([name, items]) => ({ name, items })) };
}

// Permissions the Accounting Supervisor must never lose, and combinations that would break separation of duties.
const LOCKED_SUPER = ["users.manage", "roles.manage", "settings.manage"];
// overtime.submit together with overtime.approve is allowed since 2026-11-13 (staff decide employees' requests);
// decideOvertime still refuses whoever encoded the overtime
const CONFLICTS = [["payroll.prepare", "payroll.approve"], ["payroll.prepare", "payroll.finalize"], ["payroll.adjust.submit", "payroll.adjust.approve"], ["payitems.submit", "payitems.approve"]];

export async function savePermissions(req, body) {
  const roles = await select("SELECT id, code, name FROM roles");
  const perms = await select("SELECT id, code FROM permissions");
  const code = new Map(perms.map((p) => [p.id, p.code]));
  const wanted = new Map();
  for (const r of roles) wanted.set(r.id, new Set(Object.keys(body[`r${r.id}`] || {}).map((k) => Number(k.replace(/^p/, ""))).filter((id) => code.has(id))));
  for (const r of roles) {
    const names = new Set([...wanted.get(r.id)].map((id) => code.get(id)));
    if (r.code === "accounting_supervisor") for (const p of LOCKED_SUPER) if (!names.has(p)) throw badRequest(`The Accounting Supervisor must keep "${p}", otherwise nobody could manage the system.`);
    for (const [a, b] of CONFLICTS) if (names.has(a) && names.has(b)) throw badRequest(`${r.name} cannot hold both "${a}" and "${b}": one person would be able to approve their own work.`);
  }
  let added = 0, removed = 0;
  await tx(async (trx) => {
    const current = await select("SELECT role_id, permission_id FROM role_permissions", [], trx);
    const before = new Set(current.map((g) => `${g.role_id}:${g.permission_id}`));
    const after = new Set();
    for (const [roleId, set] of wanted) for (const pid of set) after.add(`${roleId}:${pid}`);
    const log = [];
    for (const k of after) if (!before.has(k)) { const [r, p] = k.split(":").map(Number); await exec("INSERT INTO role_permissions (role_id, permission_id) VALUES (?,?)", [r, p], trx); added++; log.push(`+ ${roles.find((x) => x.id === r).code}: ${code.get(p)}`); }
    for (const k of before) if (!after.has(k)) { const [r, p] = k.split(":").map(Number); await exec("DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?", [r, p], trx); removed++; log.push(`- ${roles.find((x) => x.id === r).code}: ${code.get(p)}`); }
    if (log.length) await audit(req, { action: "role_permissions_updated", module: "users", recordType: "role_permissions", next: { changes: log.slice(0, 80) } }, trx);
  });
  clearPermissionCache();
  return { added, removed };
}

// ---- security monitor ----------------------------------------------------------------------------------------------------------------
const SENSITIVE = ["password_reset_link_created", "password_reset_completed", "page_printed", "audit_verified", "backup_failed", "user_removed", "bank_number_revealed", "document_viewed", "report_exported", "password_reset_by_admin", "role_permissions_updated", "settings_updated", "backup_created", "backup_downloaded", "backup_deleted", "database_restored", "payroll_batch_voided", "user_unlocked", "sessions_revoked"];

export async function securityOverview() {
  const [failed24, failed7, locked, sessions, inactive, recentFailed, sensitive] = await Promise.all([
    scalar("SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'login_%' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)"),
    scalar("SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'login_%' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)"),
    select("SELECT id, full_name, email, locked_until FROM users WHERE locked_until > NOW() AND deleted_at IS NULL"),
    scalar("SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE expires_at > NOW() AND user_id IS NOT NULL"),
    scalar("SELECT COUNT(*) FROM users WHERE status = 'active' AND deleted_at IS NULL AND must_change_password = 1"),
    select("SELECT action, user_name, ip_address, created_at, new_value FROM audit_logs WHERE action LIKE 'login_%' ORDER BY id DESC LIMIT 15"),
    select("SELECT action, user_name, user_role, record_type, record_id, remarks, created_at FROM audit_logs WHERE action IN (?) ORDER BY id DESC LIMIT 25", [SENSITIVE]),
  ]);
  return { failed24: Number(failed24), failed7: Number(failed7), locked, sessions: Number(sessions), tempPasswords: Number(inactive), recentFailed: recentFailed.map((r) => ({ ...r, email: (typeof r.new_value === "string" ? JSON.parse(r.new_value || "{}") : r.new_value)?.email })), sensitive };
}

// ---- backups -----------------------------------------------------------------------------------------------------------------------
const human = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const safeName = (name) => { if (!BACKUP_NAME.test(name || "")) throw badRequest("Invalid backup file name."); return path.join(BACKUP_DIR, name); };

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_NAME.test(f)).map((name) => { const st = fs.statSync(path.join(BACKUP_DIR, name)); return { name, size: human(st.size), created: st.mtime }; }).sort((a, b) => b.created - a.created);
}

export async function createBackup(req) {
  const name = newBackupName(), file = path.join(BACKUP_DIR, name);
  try { await dumpDatabase(file); } catch (e) { throw badRequest(e.message); }
  await audit(req, { action: "backup_created", module: "settings", recordType: "backup", recordId: name.slice(0, 40), remarks: human(fs.statSync(file).size) });
  return name;
}

export async function backupForDownload(req, name) {
  const file = safeName(name);
  if (!fs.existsSync(file)) throw notFound("Backup not found.");
  await audit(req, { action: "backup_downloaded", module: "settings", recordType: "backup", recordId: name.slice(0, 40) });
  return file;
}

export async function deleteBackup(req, name) {
  const file = safeName(name);
  if (!fs.existsSync(file)) throw notFound("Backup not found.");
  fs.rmSync(file);
  await audit(req, { action: "backup_deleted", module: "settings", recordType: "backup", recordId: name.slice(0, 40) });
}

export async function maintenanceStats() {
  const [sessions, expired, notif] = await Promise.all([
    scalar("SELECT COUNT(*) FROM user_sessions"), scalar("SELECT COUNT(*) FROM user_sessions WHERE expires_at <= NOW()"), scalar("SELECT COUNT(*) FROM notifications WHERE is_read = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 180 DAY)"),
  ]);
  const size = await selectOne("SELECT ROUND(SUM(data_length + index_length)/1048576, 2) AS mb, COUNT(*) AS tables_n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [env.db.name]);
  return { sessions: Number(sessions), expired: Number(expired), oldNotifications: Number(notif), dbMb: size.mb, tables: size.tables_n };
}

/** Retention clean-up (also runs daily on its own): data the retention policy says is no longer needed. */
export async function runCleanup(req, actor = null) {
  const a = await exec("DELETE FROM user_sessions WHERE expires_at <= NOW()");
  const b = await exec("DELETE FROM notifications WHERE is_read = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 180 DAY)");
  const c = await exec("DELETE FROM password_resets WHERE COALESCE(used_at, expires_at) < DATE_SUB(NOW(), INTERVAL 7 DAY)");
  const d = await exec("UPDATE account_requests SET password_hash = '', hr_code_enc = '' WHERE status = 'rejected' AND decided_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND password_hash <> ''");
  const summary = { sessions: a.affectedRows, notifications: b.affectedRows, resetLinks: c.affectedRows, requests: d.affectedRows };
  await audit(req, { action: "maintenance_cleanup", module: "settings", actor, remarks: `${summary.sessions} expired sessions, ${summary.notifications} old read notifications, ${summary.resetLinks} old reset links, ${summary.requests} rejected requests' secrets removed` });
  return summary;
}

const BACKUP_ACTOR = { id: null, full_name: "Automatic backup", role_code: "system" };

/** Removes automatic and manual backups older than keepDays, always keeping the newest three. */
export function pruneBackups(keepDays) {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_NAME.test(f))
    .map((name) => ({ name, at: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs })).sort((x, y) => y.at - x.at);
  const cutoff = Date.now() - keepDays * 86400000;
  const old = files.slice(3).filter((f) => f.at < cutoff);
  for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f.name));
  return old.map((f) => f.name);
}

/** The daily automatic backup. A failure is recorded and everyone who manages settings is notified. */
export async function runAutomaticBackup() {
  const keepDays = Math.max(1, Number(await getSetting("backup.keep_days", "14")) || 14);
  const name = newBackupName(), file = path.join(BACKUP_DIR, name);
  try {
    await dumpDatabase(file);
  } catch (e) {
    await audit(null, { action: "backup_failed", module: "settings", actor: BACKUP_ACTOR, remarks: String(e.message).slice(0, 400) });
    await notifyPermission("settings.manage", { type: "backup_failed", title: "Automatic backup failed", message: String(e.message).slice(0, 300), link: "/settings/backup" });
    throw e;
  }
  await audit(null, { action: "backup_created", module: "settings", actor: BACKUP_ACTOR, recordType: "backup", recordId: name.slice(0, 40), remarks: `Automatic · ${human(fs.statSync(file).size)}` });
  const pruned = pruneBackups(keepDays);
  if (pruned.length) await audit(null, { action: "backup_pruned", module: "settings", actor: BACKUP_ACTOR, remarks: `${pruned.length} backup(s) older than ${keepDays} days removed` });
  return { name, pruned };
}
