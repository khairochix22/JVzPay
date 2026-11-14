// Company bank accounts and bank reconciliation (master prompt §IX).
// Each bank account is booked in its own cash account. Reconciling a statement means ticking the journal lines the bank
// has cleared; the statement balance must equal the cleared book balance (opening cleared balance + ticked lines)
// before the reconciliation can be closed. A line is cleared only once, ever.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { encrypt } from "../lib/crypto.js";
import { toCents, fromCents } from "../lib/money.js";
import { badRequest, notFound } from "../lib/errors.js";

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const money = (v) => { const s = String(v ?? "").replace(/[,\s₱]/g, ""); return /^-?\d+(\.\d{1,2})?$/.test(s) ? s : null; };

export const listBankAccounts = () =>
  select(`SELECT b.*, a.code AS gl_code, a.name AS gl_name,
                 (SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id AND j.status IN ('posted','reversed') WHERE l.account_id = b.gl_account_id) AS book_balance,
                 (SELECT MAX(statement_date) FROM bank_reconciliations r WHERE r.bank_account_id = b.id AND r.status = 'reconciled') AS last_reconciled
            FROM company_bank_accounts b JOIN chart_of_accounts a ON a.id = b.gl_account_id ORDER BY b.is_active DESC, b.bank_name`);

export const unusedCashAccounts = () =>
  select("SELECT id, code, name FROM chart_of_accounts WHERE is_cash = 1 AND is_active = 1 AND id NOT IN (SELECT gl_account_id FROM company_bank_accounts) ORDER BY code");

export async function addBankAccount(req, body) {
  const digits = String(body.account_number || "").replace(/[\s-]/g, "");
  const v = { bank_name: String(body.bank_name || "").trim().slice(0, 120), account_name: String(body.account_name || "").trim().slice(0, 160), gl_account_id: Number(body.gl_account_id) };
  const errors = {};
  if (!v.bank_name) errors.bank_name = "Enter the bank.";
  if (!v.account_name) errors.account_name = "Enter the account name.";
  if (!/^\d{6,20}$/.test(digits)) errors.account_number = "Enter the account number (6–20 digits).";
  if (!v.gl_account_id) errors.gl_account_id = "Choose the cash account it is booked in.";
  if (Object.keys(errors).length) return { errors, values: v };
  if (!(await selectOne("SELECT id FROM chart_of_accounts WHERE id = ? AND is_cash = 1", [v.gl_account_id]))) return { errors: { gl_account_id: "Choose a cash account." }, values: v };
  if (await selectOne("SELECT id FROM company_bank_accounts WHERE gl_account_id = ?", [v.gl_account_id])) return { errors: { gl_account_id: "That cash account already belongs to a bank account." }, values: v };
  const { insertId } = await exec("INSERT INTO company_bank_accounts (bank_name, account_name, account_no_enc, account_last4, gl_account_id, created_by) VALUES (?,?,?,?,?,?)",
    [v.bank_name, v.account_name, encrypt(digits), digits.slice(-4), v.gl_account_id, req.user.id]);
  await audit(req, { action: "company_bank_account_added", module: "accounting", recordType: "company_bank_account", recordId: insertId, next: { bank: v.bank_name, account: `••••${digits.slice(-4)}` } });
  return { id: insertId };
}

export async function startReconciliation(req, bankAccountId, body) {
  const date = String(body.statement_date || ""), bal = money(body.statement_balance);
  if (!isDate(date)) throw badRequest("Enter the statement date.");
  if (bal === null) throw badRequest("Enter the statement's ending balance.");
  const bank = await selectOne("SELECT id FROM company_bank_accounts WHERE id = ? AND is_active = 1", [bankAccountId]);
  if (!bank) throw notFound("Bank account not found.");
  if (await selectOne("SELECT id FROM bank_reconciliations WHERE bank_account_id = ? AND status = 'open'", [bankAccountId])) throw badRequest("Finish the open reconciliation for this account first.");
  const last = await selectOne("SELECT MAX(statement_date) AS d FROM bank_reconciliations WHERE bank_account_id = ? AND status = 'reconciled'", [bankAccountId]);
  if (last?.d && date <= String(last.d instanceof Date ? last.d.toISOString() : last.d).slice(0, 10)) throw badRequest("The statement date must be after the last reconciled statement.");
  const { insertId } = await exec("INSERT INTO bank_reconciliations (bank_account_id, statement_date, statement_balance, notes, created_by) VALUES (?,?,?,?,?)",
    [bankAccountId, date, bal, String(body.notes || "").trim().slice(0, 255) || null, req.user.id]);
  await audit(req, { action: "bank_reconciliation_started", module: "accounting", recordType: "bank_reconciliation", recordId: insertId, next: { statement_date: date, statement_balance: bal } });
  return insertId;
}

/** The reconciliation with every uncleared posted line up to the statement date, and the running totals. */
export async function getReconciliation(id) {
  const r = await selectOne(`SELECT r.*, b.bank_name, b.account_name, b.account_last4, b.gl_account_id FROM bank_reconciliations r JOIN company_bank_accounts b ON b.id = r.bank_account_id WHERE r.id = ?`, [id]);
  if (!r) throw notFound("Reconciliation not found.");
  // cleared before this statement (earlier reconciliations): the opening cleared balance
  const opening = Number(await scalar(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM bank_reconciliation_items i JOIN bank_reconciliations x ON x.id = i.reconciliation_id AND x.status = 'reconciled'
       JOIN journal_entry_lines l ON l.id = i.journal_entry_line_id WHERE x.bank_account_id = ?`, [r.bank_account_id]));
  const lines = await select(
    `SELECT l.id, l.debit, l.credit, l.description, j.entry_no, j.entry_date, j.description AS entry_description, (i.id IS NOT NULL) AS cleared
       FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id AND j.status IN ('posted','reversed')
       LEFT JOIN bank_reconciliation_items i ON i.journal_entry_line_id = l.id
      WHERE l.account_id = ? AND j.entry_date <= ? AND (i.id IS NULL OR i.reconciliation_id = ?)
      ORDER BY j.entry_date, l.id`, [r.gl_account_id, r.statement_date, id]);
  const clearedNow = lines.filter((l) => Number(l.cleared)).reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0);
  const cleared = toCents(opening) + clearedNow;
  return { r, lines, opening: fromCents(toCents(opening)), cleared: fromCents(cleared), difference: fromCents(toCents(r.statement_balance) - cleared), balanced: toCents(r.statement_balance) === cleared };
}

export async function saveCleared(req, id, lineIds, finish) {
  return tx(async (trx) => {
    const r = await selectOne("SELECT r.*, b.gl_account_id FROM bank_reconciliations r JOIN company_bank_accounts b ON b.id = r.bank_account_id WHERE r.id = ? FOR UPDATE", [id], trx);
    if (!r) throw notFound("Reconciliation not found.");
    if (r.status !== "open") throw badRequest("This reconciliation is closed.");
    const ids = [...new Set((Array.isArray(lineIds) ? lineIds : lineIds ? [lineIds] : []).map(Number).filter(Boolean))];
    await exec("DELETE FROM bank_reconciliation_items WHERE reconciliation_id = ?", [id], trx);
    for (const lineId of ids) {
      const ok = await selectOne(
        `SELECT l.id FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id AND j.status IN ('posted','reversed')
          WHERE l.id = ? AND l.account_id = ? AND j.entry_date <= ? AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_items i WHERE i.journal_entry_line_id = l.id)`,
        [lineId, r.gl_account_id, r.statement_date], trx);
      if (ok) await exec("INSERT INTO bank_reconciliation_items (reconciliation_id, journal_entry_line_id) VALUES (?,?)", [id, lineId], trx);
    }
    if (finish) {
      const opening = Number(await scalar(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM bank_reconciliation_items i JOIN bank_reconciliations x ON x.id = i.reconciliation_id AND x.status = 'reconciled'
           JOIN journal_entry_lines l ON l.id = i.journal_entry_line_id WHERE x.bank_account_id = ?`, [r.bank_account_id], trx));
      const now = Number(await scalar("SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM bank_reconciliation_items i JOIN journal_entry_lines l ON l.id = i.journal_entry_line_id WHERE i.reconciliation_id = ?", [id], trx));
      const cleared = toCents(opening) + toCents(now);
      if (cleared !== toCents(r.statement_balance)) throw badRequest(`It does not balance yet: the cleared book balance is ₱${fromCents(cleared)}, the statement says ₱${r.statement_balance}.`);
      await exec("UPDATE bank_reconciliations SET status = 'reconciled', cleared_balance = ?, reconciled_by = ?, reconciled_at = NOW() WHERE id = ?", [fromCents(cleared), req.user.id, id], trx);
      await audit(req, { action: "bank_reconciled", module: "accounting", recordType: "bank_reconciliation", recordId: id, next: { statement_date: r.statement_date, balance: r.statement_balance, items: ids.length } }, trx);
    }
  });
}

export const listReconciliations = () =>
  select(`SELECT r.*, b.bank_name, b.account_last4, u.full_name AS reconciled_by_name FROM bank_reconciliations r JOIN company_bank_accounts b ON b.id = r.bank_account_id
            LEFT JOIN users u ON u.id = r.reconciled_by ORDER BY r.status = 'open' DESC, r.statement_date DESC LIMIT 50`);
