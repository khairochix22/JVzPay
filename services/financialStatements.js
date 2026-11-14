// Financial statements, computed only from posted journals (reversed originals and their reversals net to zero).
// Rows carry _kind: "heading" | "total" | "grand" so screen, PDF and Excel can style them identically.
import { select, selectOne, scalar } from "../lib/db.js";
import { toCents, fromCents } from "../lib/money.js";

const POSTED = "j.status IN ('posted','reversed')";

async function balances({ from = null, to = null }) {
  const where = [POSTED]; const params = [];
  if (from) { where.push("j.entry_date >= ?"); params.push(from); }
  if (to) { where.push("j.entry_date <= ?"); params.push(to); }
  return select(
    `SELECT a.id, a.code, a.name, a.account_type, a.normal_balance, a.is_cash, SUM(l.debit) AS d, SUM(l.credit) AS c
       FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE ${where.join(" AND ")} GROUP BY a.id ORDER BY a.code`, params);
}
const net = (a, side) => (side === "debit" ? toCents(a.d) - toCents(a.c) : toCents(a.c) - toCents(a.d));
const m = (c) => fromCents(c);
const COL2 = [{ key: "label", label: "Account" }, { key: "amount", label: "Amount", type: "money" }];

export async function incomeStatement(from, to) {
  const rows = await balances({ from, to });
  const revenue = rows.filter((a) => a.account_type === "revenue"), expense = rows.filter((a) => a.account_type === "expense");
  const tr = revenue.reduce((s, a) => s + net(a, "credit"), 0), te = expense.reduce((s, a) => s + net(a, "debit"), 0);
  return {
    columns: COL2, netIncome: tr - te,
    rows: [
      { _kind: "heading", label: "Revenue" }, ...revenue.map((a) => ({ label: `${a.code}  ${a.name}`, amount: m(net(a, "credit")) })), { _kind: "total", label: "Total revenue", amount: m(tr) },
      { _kind: "heading", label: "Expenses" }, ...expense.map((a) => ({ label: `${a.code}  ${a.name}`, amount: m(net(a, "debit")) })), { _kind: "total", label: "Total expenses", amount: m(te) },
      { _kind: "grand", label: tr - te >= 0 ? "Net income" : "Net loss", amount: m(tr - te) },
    ],
  };
}

export async function balanceSheet(asOf) {
  const rows = await balances({ to: asOf });
  const by = (t) => rows.filter((a) => a.account_type === t);
  const sum = (list, side) => list.reduce((s, a) => s + net(a, side), 0);
  const assets = sum(by("asset"), "debit"), liab = sum(by("liability"), "credit"), eq = sum(by("equity"), "credit");
  const earnings = sum(by("revenue"), "credit") - sum(by("expense"), "debit");
  const balanced = assets === liab + eq + earnings;
  const line = (a, side) => ({ label: `${a.code}  ${a.name}`, amount: m(net(a, side)) });
  return {
    columns: COL2, balanced,
    rows: [
      { _kind: "heading", label: "Assets" }, ...by("asset").map((a) => line(a, "debit")), { _kind: "total", label: "Total assets", amount: m(assets) },
      { _kind: "heading", label: "Liabilities" }, ...by("liability").map((a) => line(a, "credit")), { _kind: "total", label: "Total liabilities", amount: m(liab) },
      { _kind: "heading", label: "Equity" }, ...by("equity").map((a) => line(a, "credit")), { label: "Net income to date (not yet closed to retained earnings)", amount: m(earnings) }, { _kind: "total", label: "Total equity", amount: m(eq + earnings) },
      { _kind: "grand", label: "Total liabilities and equity", amount: m(liab + eq + earnings) },
    ],
    notes: balanced ? [] : ["WARNING: assets do not equal liabilities plus equity. Investigate before relying on this statement."],
  };
}

export async function trialBalance(asOf) {
  const rows = await balances({ to: asOf });
  let td = 0, tc = 0;
  const out = rows.map((a) => {
    const n = toCents(a.d) - toCents(a.c);
    if (n >= 0) td += n; else tc += -n;
    return { code: a.code, name: a.name, type: a.account_type, debit: n > 0 ? m(n) : "", credit: n < 0 ? m(-n) : "" };
  });
  return {
    columns: [{ key: "code", label: "Code" }, { key: "name", label: "Account" }, { key: "type", label: "Type" }, { key: "debit", label: "Debit", type: "money" }, { key: "credit", label: "Credit", type: "money" }],
    rows: [...out, { _kind: "grand", code: "", name: "Totals", type: "", debit: m(td), credit: m(tc) }], balanced: td === tc,
    notes: td === tc ? [] : ["WARNING: total debits do not equal total credits."],
  };
}

export async function generalLedger(accountId, from, to) {
  const accounts = await select(`SELECT * FROM chart_of_accounts ${accountId ? "WHERE id = ?" : ""} ORDER BY code`, accountId ? [accountId] : []);
  const rows = [];
  for (const a of accounts) {
    const opening = await selectOne(
      `SELECT COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS c FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id
        WHERE l.account_id = ? AND ${POSTED} AND j.entry_date < ?`, [a.id, from]);
    const lines = await select(
      `SELECT j.entry_date, j.entry_no, j.description, l.debit, l.credit FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id
        WHERE l.account_id = ? AND ${POSTED} AND j.entry_date BETWEEN ? AND ? ORDER BY j.entry_date, j.id, l.line_no`, [a.id, from, to]);
    let bal = net(opening, a.normal_balance);
    if (!lines.length && !bal) continue;
    rows.push({ _kind: "heading", date: `${a.code}  ${a.name}` });
    rows.push({ date: "", entry: "", description: "Opening balance", debit: "", credit: "", balance: m(bal) });
    let td = 0, tc = 0;
    for (const l of lines) {
      const d = toCents(l.debit), c = toCents(l.credit);
      td += d; tc += c;
      bal += a.normal_balance === "debit" ? d - c : c - d;
      rows.push({ date: l.entry_date, entry: l.entry_no, description: l.description, debit: d ? m(d) : "", credit: c ? m(c) : "", balance: m(bal) });
    }
    rows.push({ _kind: "total", date: "", entry: "", description: "Period totals", debit: m(td), credit: m(tc), balance: m(bal) });
  }
  return { columns: [{ key: "date", label: "Date" }, { key: "entry", label: "Entry" }, { key: "description", label: "Description" }, { key: "debit", label: "Debit", type: "money" }, { key: "credit", label: "Credit", type: "money" }, { key: "balance", label: "Balance", type: "money" }], rows };
}

function classify(counter) {
  if (!counter) return ["operating", "Other operating cash movements"];
  if (counter.account_type === "revenue" || counter.code === "1100") return ["operating", "Cash received from customers and other income"];
  if (counter.code === "2100") return ["operating", "Salaries and wages paid"];
  if (["2200", "2210", "2220", "2230", "2240"].includes(counter.code)) return ["operating", "Government contributions and taxes remitted"];
  if (counter.account_type === "expense" || counter.account_type === "liability") return ["operating", "Payments to suppliers and for operating expenses"];
  if (counter.account_type === "equity") return ["financing", "Owner contributions and withdrawals"];
  return ["investing", "Purchases and sales of other assets"];
}

/** Direct method: each journal touching a cash account is classified by its largest non-cash line. */
export async function cashFlow(from, to) {
  const opening = toCents(await scalar(
    `SELECT COALESCE(SUM(l.debit - l.credit),0) FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE a.is_cash = 1 AND ${POSTED} AND j.entry_date < ?`, [from]));
  const lines = await select(
    `SELECT l.entry_id, l.debit, l.credit, a.code, a.account_type, a.is_cash FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE ${POSTED} AND j.entry_date BETWEEN ? AND ? AND l.entry_id IN (
        SELECT l2.entry_id FROM journal_entry_lines l2 JOIN chart_of_accounts a2 ON a2.id = l2.account_id WHERE a2.is_cash = 1)`, [from, to]);
  const entries = new Map();
  for (const l of lines) { if (!entries.has(l.entry_id)) entries.set(l.entry_id, []); entries.get(l.entry_id).push(l); }
  const buckets = { operating: new Map(), investing: new Map(), financing: new Map() };
  for (const ls of entries.values()) {
    const delta = ls.filter((l) => l.is_cash).reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0);
    if (!delta) continue;
    const others = ls.filter((l) => !l.is_cash).sort((a, b) => Math.abs(toCents(b.debit) + toCents(b.credit)) - Math.abs(toCents(a.debit) + toCents(a.credit)));
    const [section, label] = classify(others[0]);
    buckets[section].set(label, (buckets[section].get(label) || 0) + delta);
  }
  const rows = []; let netChange = 0;
  for (const [key, title] of [["operating", "Operating activities"], ["investing", "Investing activities"], ["financing", "Financing activities"]]) {
    rows.push({ _kind: "heading", label: title });
    let sub = 0;
    for (const [label, v] of buckets[key]) { rows.push({ label, amount: m(v) }); sub += v; }
    if (!buckets[key].size) rows.push({ label: "None in this period", amount: m(0) });
    rows.push({ _kind: "total", label: `Net cash from ${key} activities`, amount: m(sub) });
    netChange += sub;
  }
  rows.push({ _kind: "grand", label: "Net change in cash", amount: m(netChange) });
  rows.push({ label: "Cash at beginning of period", amount: m(opening) });
  rows.push({ _kind: "grand", label: "Cash at end of period", amount: m(opening + netChange) });
  return { columns: COL2, rows, notes: ["Prepared by the direct method from posted journals. Each cash entry is classified by its largest non-cash line, so an entry mixing several purposes appears under one heading."] };
}

/** Revenue, expense and net income per month for a year. */
export async function monthlyFinancials(year) {
  const rows = await select(
    `SELECT MONTH(j.entry_date) AS mo, a.account_type, a.code, SUM(l.debit) AS d, SUM(l.credit) AS c FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE ${POSTED} AND YEAR(j.entry_date) = ? AND a.account_type IN ('revenue','expense') GROUP BY mo, a.account_type, a.code`, [year]);
  return Array.from({ length: 12 }, (_, i) => {
    const mo = i + 1, of = rows.filter((r) => r.mo === mo);
    const revenue = of.filter((r) => r.account_type === "revenue").reduce((s, r) => s + toCents(r.c) - toCents(r.d), 0);
    const expense = of.filter((r) => r.account_type === "expense").reduce((s, r) => s + toCents(r.d) - toCents(r.c), 0);
    const payroll = of.filter((r) => ["5010", "5020", "5030"].includes(r.code)).reduce((s, r) => s + toCents(r.d) - toCents(r.c), 0);
    return { mo, revenue, expense, payroll, net: revenue - expense };
  });
}
