import { exec, tx } from "./db.js";

// Atomic counter. Uses LAST_INSERT_ID(expr) so concurrent callers never receive the same number.
export async function nextValue(name, trx = null) {
  const run = async (t) => {
    const r = await exec(
      "INSERT INTO sequences (name, current_value) VALUES (?, LAST_INSERT_ID(1)) " +
        "ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)",
      [name],
      t
    );
    return Number(r.insertId);
  };
  return trx ? run(trx) : tx(run);
}

// e.g. nextDocNo("PB", 4)  ->  "PB-2026-0001"   (counter resets each calendar year)
export async function nextDocNo(prefix, pad = 4, trx = null, date = new Date()) {
  const year = date.getFullYear();
  const n = await nextValue(`${prefix}-${year}`, trx);
  return `${prefix}-${year}-${String(n).padStart(pad, "0")}`;
}
