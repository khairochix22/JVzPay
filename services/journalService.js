// Double-entry journal (Module 8). Every posting goes through here: entries are created as drafts, lines are added, then the
// database trigger validates debits = credits on posting. Posted entries are immutable; corrections are reversing entries.
import { select, selectOne, exec } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { nextDocNo, nextValue } from "../lib/sequence.js";
import { badRequest, notFound } from "../lib/errors.js";
import { fromCents } from "../lib/money.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");

/** Monthly financial period for a date (created on first use). Posting into a closed period is refused. */
export async function ensureFinancialPeriod(date, trx) {
  const d = String(date).slice(0, 10);
  const [y, m] = d.split("-").map(Number);
  const start = `${y}-${pad(m)}-01`;
  const end = `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
  await exec("INSERT IGNORE INTO financial_periods (label, start_date, end_date) VALUES (?,?,?)", [`${MONTHS[m - 1]} ${y}`, start, end], trx);
  const p = await selectOne("SELECT * FROM financial_periods WHERE start_date = ? AND end_date = ?", [start, end], trx);
  if (p.status === "closed") throw badRequest(`The financial period ${p.label} is closed. Choose a date in an open period.`);
  return p;
}

async function resolveAccount(ref, trx) {
  const a = await selectOne(`SELECT id, code, name, is_active FROM chart_of_accounts WHERE ${typeof ref === "string" ? "code" : "id"} = ?`, [ref], trx);
  if (!a) throw badRequest(`Account ${ref} does not exist in the chart of accounts.`);
  return a;
}

/**
 * Creates a draft entry. `lines` = [{ account: "5010" | accountId, debit?: centavos, credit?: centavos, description?, employeeId? }].
 * Zero lines are dropped. Manual and reversal entries get a unique source_id so the (source, event) key stays unique.
 */
export async function createDraft({ req, date, description, sourceType = "manual", sourceId = null, sourceEvent = "posting", lines }, trx) {
  const period = await ensureFinancialPeriod(date, trx);
  const entryNo = await nextDocNo("JE", 5, trx, new Date(`${String(date).slice(0, 10)}T00:00:00`));
  const sid = sourceId ?? (await nextValue("journal_manual", trx));
  const { insertId } = await exec(
    `INSERT INTO journal_entries (entry_no, entry_date, period_id, description, source_type, source_id, source_event, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [entryNo, date, period.id, String(description).slice(0, 255), sourceType, sid, sourceEvent, req?.user?.id ?? null], trx); // null: posted by an integration event
  let n = 0;
  for (const l of lines) {
    const debit = Math.round(l.debit || 0), credit = Math.round(l.credit || 0);
    if (debit === 0 && credit === 0) continue;
    if (debit < 0 || credit < 0) throw badRequest("Journal lines cannot be negative.");
    const acct = await resolveAccount(l.account, trx);
    await exec(
      "INSERT INTO journal_entry_lines (entry_id, line_no, account_id, debit, credit, description, employee_id) VALUES (?,?,?,?,?,?,?)",
      [insertId, ++n, acct.id, fromCents(debit), fromCents(credit), l.description ? String(l.description).slice(0, 255) : null, l.employeeId ?? null], trx);
  }
  return { id: insertId, entryNo };
}

export async function postDraft(req, entryId, trx) {
  await exec("UPDATE journal_entries SET status = 'posted', posted_by = ?, posted_at = NOW() WHERE id = ? AND status = 'draft'", [req?.user?.id ?? null, entryId], trx);
  const e = await selectOne("SELECT id, entry_no, total_debit, description, source_type, source_id, source_event FROM journal_entries WHERE id = ?", [entryId], trx);
  await audit(req, { action: "journal_posted", module: "accounting", recordType: "journal_entry", recordId: entryId, next: e }, trx);
  return e;
}

/** Creates and posts in one step. The database refuses unbalanced entries and duplicate source postings. */
export async function postEntry(args, trx) {
  const { id, entryNo } = await createDraft(args, trx);
  await postDraft(args.req, id, trx);
  return { id, entryNo };
}

/** Posts the mirror image of a posted entry and marks the original as reversed. */
export async function reverseEntry(req, entryId, reason, trx, date = null) {
  const e = await selectOne("SELECT * FROM journal_entries WHERE id = ? FOR UPDATE", [entryId], trx);
  if (!e) throw notFound("Journal entry not found.");
  if (e.status !== "posted") throw badRequest("Only posted entries can be reversed.");
  const lines = await select("SELECT * FROM journal_entry_lines WHERE entry_id = ? ORDER BY line_no", [entryId], trx);
  const toC = (v) => Math.round(Number(v) * 100);
  const when = date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  const rev = await createDraft({
    req, date: when, description: `Reversal of ${e.entry_no}: ${reason}`, sourceType: "reversal", sourceId: e.id, sourceEvent: "reversal",
    lines: lines.map((l) => ({ account: Number(l.account_id), debit: toC(l.credit), credit: toC(l.debit), description: l.description, employeeId: l.employee_id })),
  }, trx);
  await exec("UPDATE journal_entries SET reverses_entry_id = ? WHERE id = ?", [e.id, rev.id], trx);
  await postDraft(req, rev.id, trx);
  await exec("UPDATE journal_entries SET status = 'reversed' WHERE id = ?", [e.id], trx);
  await audit(req, { action: "journal_reversed", module: "accounting", recordType: "journal_entry", recordId: e.id, remarks: reason, next: { reversal_entry: rev.entryNo } }, trx);
  return rev;
}
