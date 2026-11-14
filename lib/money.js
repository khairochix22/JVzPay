// Money is handled as integer centavos in JS (never floats) and stored as DECIMAL(…,2) in MySQL.

export function toCents(value) {
  if (value === null || value === undefined || value === "") return 0;
  const s = String(value).trim().replace(/[,₱\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid money amount: "${value}"`);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  // round half up on the third decimal
  const cents = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2)) + (frac.length > 2 && frac[2] >= "5" ? 1n : 0n);
  const n = Number(neg ? -cents : cents);
  return n;
}

export function fromCents(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

export const isMoney = (v) => /^\d{1,12}(\.\d{1,2})?$/.test(String(v ?? "").trim().replace(/,/g, ""));

// "1234567.5" -> "₱1,234,567.50"
export function formatPHP(value) {
  if (value === null || value === undefined || value === "") return "₱0.00";
  const c = toCents(value);
  const [w, f] = fromCents(Math.abs(c)).split(".");
  return `${c < 0 ? "-" : ""}₱${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
}
