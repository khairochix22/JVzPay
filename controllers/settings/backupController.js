// Backup & Maintenance page (GET/POST /settings/backup): compressed database dumps, the automatic daily backup,
// and housekeeping (settings.manage).
import { wrap, action } from "../../lib/errors.js";
import { getSetting } from "../../lib/settings.js";
import { listBackups, createBackup, backupForDownload, deleteBackup, maintenanceStats, runCleanup } from "../../services/adminService.js";
import { systemHealth } from "../../services/securityService.js";

export const page = wrap(async (req, res) => {
  const [stats, health, enabled, time, keepDays] = await Promise.all([
    maintenanceStats(), systemHealth(), getSetting("backup.auto_enabled", "1"), getSetting("backup.time", "02:00"), getSetting("backup.keep_days", "14"),
  ]);
  res.render("backup", {
    title: "Backup & Maintenance", backups: listBackups(), stats, health,
    auto: { enabled: ["1", "true"].includes(String(enabled)), time, keepDays },
  });
});

export const create = action(async (req) => `Backup ${await createBackup(req)} was created.`, "/settings/backup");

export const download = wrap(async (req, res) => {
  res.download(await backupForDownload(req, req.params.name));
});

export const remove = action(async (req) => { await deleteBackup(req, req.params.name); return "Backup deleted."; }, "/settings/backup");

export const cleanup = action(async (req) => {
  const r = await runCleanup(req);
  return `Removed ${r.sessions} expired session(s), ${r.notifications} old read notification(s), ${r.resetLinks} old reset link(s) and the secrets of ${r.requests} old rejected request(s).`;
}, "/settings/backup");
