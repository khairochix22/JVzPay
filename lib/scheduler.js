// Background jobs that run inside the app process:
//  - every minute: seal new audit records;
//  - once a day, at the time set in System Settings (or the first minute the app runs after it):
//    back up the database, prune old automatic backups and remove data the retention policy says is no longer needed;
//  - every hour: create the coming kinsenas/katapusan periods and compute the payroll of any period whose cutoff has passed;
//  - every minute: send queued integration events and read Inventory's outbox; every 15 minutes: pull HR's records.
// Set DISABLE_SCHEDULER=1 to turn this off (automated tests do).
//
// ONE SCHEDULER PER SERVER: these jobs must run in exactly one process. Run the app as ONE PM2 process (fork mode,
// instances: 1 — ecosystem.config.cjs). Two processes would compute payroll, pull HR, poll Inventory and back up twice.
// As a safety net, a PM2 cluster instance other than #0 (NODE_APP_INSTANCE) does not start it.
import { scalar } from "./db.js";
import { deliverDue, targetConfig } from "../services/integrationService.js";
import { syncFromHr, SYNC_EVERY_MS } from "../services/hrSyncService.js";
import { pollInventory, pollEnabled } from "../services/inventoryPollService.js";
import { getSetting } from "./settings.js";
import { sealPending } from "./auditSeal.js";
import { runAutomaticBackup, runCleanup } from "../services/adminService.js";
import { autoCompute } from "../services/payrollScheduleService.js";

const manilaNow = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Manila" }); // "YYYY-MM-DD HH:MM:SS"
const SYSTEM = { id: null, full_name: "Scheduler", role_code: "system" };

/** Runs today's backup and clean-up if they are due and have not run yet. `force` ignores the clock (used by tests). */
export async function runDailyJobs({ force = false } = {}) {
  const enabled = ["1", "true"].includes(String(await getSetting("backup.auto_enabled", "1")));
  const at = String(await getSetting("backup.time", "02:00"));
  const now = manilaNow().slice(11, 16);
  const done = { backup: false, cleanup: false };
  if (!force && now < at) return done;

  const backedUpToday = Number(await scalar("SELECT COUNT(*) FROM audit_logs WHERE action = 'backup_created' AND user_role = 'system' AND created_at >= CURDATE()"));
  const failedRecently = Number(await scalar("SELECT COUNT(*) FROM audit_logs WHERE action = 'backup_failed' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)"));
  if (enabled && (force || (!backedUpToday && !failedRecently))) {
    try { await runAutomaticBackup(); done.backup = true; } catch (e) { console.error(`[${new Date().toISOString()}] automatic backup failed:`, e.message); }
  }
  const cleanedToday = Number(await scalar("SELECT COUNT(*) FROM audit_logs WHERE action = 'maintenance_cleanup' AND user_role = 'system' AND created_at >= CURDATE()"));
  if (force || !cleanedToday) { await runCleanup(null, SYSTEM); done.cleanup = true; }
  return done;
}

export function startScheduler() {
  if (process.env.DISABLE_SCHEDULER === "1") return;
  const instance = process.env.NODE_APP_INSTANCE;
  if (instance !== undefined && instance !== "" && instance !== "0") {
    console.warn(`⚠️  Scheduler not started in PM2 instance ${instance}: it runs only in instance 0. Use instances: 1 (ecosystem.config.cjs).`);
    return;
  }
  let lastPayroll = 0, lastHrSync = 0;
  const tick = async () => {
    try { await sealPending(); } catch (e) { console.error(`[${new Date().toISOString()}] audit sealing failed:`, e.message); }
    try { await runDailyJobs(); } catch (e) { console.error(`[${new Date().toISOString()}] daily jobs failed:`, e.message); }
    if (Date.now() - lastPayroll > 3_600_000) {
      lastPayroll = Date.now();
      try { await autoCompute(); } catch (e) { console.error(`[${new Date().toISOString()}] payroll schedule failed:`, e.message); }
    }
    try { await deliverDue(); } catch (e) { console.error(`[${new Date().toISOString()}] integration delivery failed:`, e.message); }
    // HR is pull-only: read its employees, departments and approved compensation every 15 minutes
    if (targetConfig("hr").connected && Date.now() - lastHrSync >= SYNC_EVERY_MS) {
      lastHrSync = Date.now();
      try { const s = await syncFromHr({ trigger: "schedule" }); if (!s.ok) console.error(`[${new Date().toISOString()}] HR sync: ${s.error}`); }
      catch (e) { console.error(`[${new Date().toISOString()}] HR sync failed:`, e.message); }
    }
    // Inventory keeps its events in an outbox: read and acknowledge them every minute
    if (targetConfig("inventory").connected && pollEnabled()) {
      try { await pollInventory({ trigger: "schedule" }); } catch (e) { console.error(`[${new Date().toISOString()}] Inventory poll failed:`, e.message); }
    }
  };
  setTimeout(tick, 5_000).unref();
  setInterval(tick, 60_000).unref();
}
