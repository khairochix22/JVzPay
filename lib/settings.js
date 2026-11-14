import { select } from "./db.js";

// Typed reader over system_settings with a short cache (settings change rarely; the Settings screen clears it).
let cache = null;
let at = 0;
const TTL = 30_000;

export const clearSettingsCache = () => { cache = null; };

async function load() {
  if (cache && Date.now() - at < TTL) return cache;
  const rows = await select("SELECT setting_key, setting_value, value_type FROM system_settings");
  cache = new Map(rows.map((r) => [r.setting_key, r]));
  at = Date.now();
  return cache;
}

export async function getSetting(key, fallback = null) {
  const r = (await load()).get(key);
  if (!r || r.setting_value === null) return fallback;
  switch (r.value_type) {
    case "number": return Number(r.setting_value);
    case "boolean": return ["1", "true", "yes", "on"].includes(String(r.setting_value).toLowerCase());
    case "json": try { return JSON.parse(r.setting_value); } catch { return fallback; }
    default: return r.setting_value;
  }
}
