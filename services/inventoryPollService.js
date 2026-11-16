// Inventory → Accounting by polling (team decision 2026-11-16). Inventory does not push events; it keeps them in an
// outbox. Every minute (lib/scheduler.js) and on "Poll now" (System → Integration), JVzPay reads
//   GET  {INVENTORY_API_URL}{INVENTORY_API_PREFIX}/accounting/outbox            (Authorization: Bearer INVENTORY_API_TOKEN)
// stores each event in its inbox exactly like a pushed one (same duplicate protection, same handlers, same retry on the
// Integration page), and then acknowledges it:
//   POST {…}/accounting/outbox/{event_id}/ack
// An event is acknowledged once it is stored, whether it posted or failed (a failed one is retried in JVzPay). An item
// that cannot even be stored (not a valid event) is not acknowledged and is reported once.
import { exec } from "../lib/db.js";
import { clearSettingsCache, getSetting } from "../lib/settings.js";
import { callApp, targetConfig, receiveEvent } from "./integrationService.js";
import { envelopeFromOutbox, outboxItems, InventoryMappingError } from "./inventoryMapping.js";
import "./salesPurchasingHandlers.js"; // registers the Inventory handlers

const SETTING = "integration.inventory_poll";
const CLIENT = { id: null, source: "johnvivz_inventory", name: "Inventory (outbox poll)" };
const MAX_ROUNDS = 10;
const itemKey = (item) => String(item?.event_id ?? item?.id ?? JSON.stringify(item)).slice(0, 200);

/**
 * The poll authenticates with INVENTORY_API_TOKEN only: the token Inventory created for JVzPay, separate from every CRM
 * credential. Throws when it is missing or is one of CRM's (a copy-paste mistake would send CRM's secret to Inventory).
 */
export function tokenProblem(env = process.env) {
  const t = String(env.INVENTORY_API_TOKEN || "").trim();
  if (!t) throw new Error("INVENTORY_API_TOKEN is not set: put the token Inventory created for JVzPay in .env");
  for (const k of ["CRM_API_TOKEN", "CRM_API_SECRET", "CRM_INBOUND_SECRET", "HR_API_TOKEN"]) {
    if (env[k] && String(env[k]).trim() === t) throw new Error(`INVENTORY_API_TOKEN is the same as ${k}: Inventory must give JVzPay its own token`);
  }
}

export const pollEnabled = () => !["0", "false", "no", "off"].includes(String(process.env.INVENTORY_POLL_ENABLED ?? "true").toLowerCase());

let running = null;
export function pollInventory({ trigger = "schedule" } = {}) {
  if (running) return running;
  running = runPoll(trigger).finally(() => { running = null; });
  return running;
}

async function runPoll(trigger) {
  const s = { at: new Date().toISOString(), trigger, ok: false, error: null, received: 0, stored: 0, duplicates: 0, processed: 0, failed: 0, acknowledged: 0, unusable: 0, problems: [] };
  const problem = (m) => { if (s.problems.length < 20) s.problems.push(String(m).slice(0, 200)); };
  try {
    if (!targetConfig("inventory").connected) throw new Error("INVENTORY_API_URL is not set");
    if (!pollEnabled()) throw new Error("polling is switched off (INVENTORY_POLL_ENABLED=false)");
    tokenProblem(); // Inventory's own token only (team decision 2026-11-16)
    const seen = new Set();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await callApp("inventory", "GET", "/accounting/outbox?limit=100");
      if (res.status === 401 || res.status === 403) throw new Error(`Inventory refused JVzPay's token (HTTP ${res.status}); check INVENTORY_API_TOKEN`);
      if (!res.ok) throw new Error(`Inventory answered HTTP ${res.status}`);
      // an item seen earlier in this poll (one JVzPay could not store) comes back in the next page: count it once
      const items = outboxItems(await res.json().catch(() => null)).filter((item) => !seen.has(itemKey(item)));
      if (!items.length) break;
      let acked = 0;
      for (const item of items) {
        seen.add(itemKey(item));
        s.received++;
        let env;
        try {
          env = envelopeFromOutbox(item);
          const r = await receiveEvent(CLIENT, env);
          if (r.status === "duplicate") s.duplicates++; else { s.stored++; s[r.status === "processed" ? "processed" : "failed"]++; }
          if (r.status === "failed") problem(`${env.event_type} ${env.event_id}: ${r.error}`);
        } catch (e) {
          if (e instanceof InventoryMappingError || e.status === 400) {
            s.unusable++;
            problem(`not stored (${e.message}); left in Inventory's outbox`);
            continue;
          }
          throw e;
        }
        const ack = await callApp("inventory", "POST", `/accounting/outbox/${encodeURIComponent(env.event_id)}/ack`, {});
        if (!ack.ok) throw new Error(`Inventory did not accept the acknowledgement of ${env.event_id} (HTTP ${ack.status}); it will be read again and recognised as a duplicate`);
        s.acknowledged++; acked++;
      }
      if (!acked) break; // only unusable items are left: wait for Inventory to fix them
    }
    s.ok = true;
  } catch (e) {
    s.error = e.name === "TimeoutError" ? "Inventory did not answer within 10 seconds" : e.cause?.code ? `Inventory could not be reached (${e.cause.code})` : e.message;
  }
  await saveSummary(s);
  return s;
}

async function saveSummary(s) {
  await exec(
    `INSERT INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES (?, ?, 'json', 'integration_status', 'Result of the last Inventory outbox poll (written by JVzPay)')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [SETTING, JSON.stringify(s)]);
  clearSettingsCache();
}

export const lastPoll = () => getSetting(SETTING, null);
