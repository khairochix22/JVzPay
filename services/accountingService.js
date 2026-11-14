// Accounting (Module 8): chart of accounts, income/expense records, adjustments, journals, financial periods.
// Accounting Supervisor entries post immediately; entries prepared by Accounting Staff wait for approval. Nothing posted is ever edited:
// voiding posts a reversing journal. Payroll expense is booked only by the payroll batch, never through this module.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notify, notifyPermission } from "../lib/notify.js";
import { nextDocNo } from "../lib/sequence.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { toCents, fromCents } from "../lib/money.js";
import { saveAttachment } from "../middleware/upload.js";
import { createDraft, postDraft, postEntry, reverseEntry } from "./journalService.js";
import { ChartOfAccount, TransactionCategory } from "../models/index.js";

export const PAYMENT_METHODS = ["cash", "bank_transfer", "check", "e_wallet", "credit"];
export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"];
const counterAccount = (txnType, method) => {
  if (method === "cash") return "1010";
  if (method === "credit") return txnType === "income" ? "1100" : "2010";
  return "1020";
};

// ---- chart of accounts ------------------------------------------------------------------------------------------------------
export async function listAccounts() {
  const rows = await select(
    `SELECT a.*, p.code AS parent_code, COALESCE(t.d,0) AS total_debit, COALESCE(t.c,0) AS total_credit
       FROM chart_of_accounts a LEFT JOIN chart_of_accounts p ON p.id = a.parent_id
       LEFT JOIN (SELECT l.account_id, SUM(l.debit) AS d, SUM(l.credit) AS c FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id
                   WHERE j.status IN ('posted','reversed') GROUP BY l.account_id) t ON t.account_id = a.id
      ORDER BY a.code`);
  return rows.map((a) => ({ ...a, balance: fromCents(a.normal_balance === "debit" ? toCents(a.total_debit) - toCents(a.total_credit) : toCents(a.total_credit) - toCents(a.total_debit)) }));
}
export const activeAccounts = () => select("SELECT id, code, name, account_type FROM chart_of_accounts WHERE is_active = 1 ORDER BY code");

export async function saveAccount(req, id, v) {
  const normal = ["asset", "expense"].includes(v.account_type) ? "debit" : "credit";
  const dupe = await ChartOfAccount.findOne({ where: { code: v.code }, raw: true });
  if (dupe && dupe.id !== id) throw badRequest("Another account already uses this code.");
  if (id) {
    const a = await ChartOfAccount.findByPk(id);
    if (!a) throw notFound("Account not found.");
    if (a.is_system && (a.code !== v.code || a.account_type !== v.account_type)) throw badRequest("System accounts are used by automatic postings: their code and type cannot change.");
    const used = Number(await scalar("SELECT COUNT(*) FROM journal_entry_lines WHERE account_id = ?", [id]));
    if (used && a.account_type !== v.account_type) throw badRequest("This account already has journal lines, so its type cannot change.");
    const prev = a.get({ plain: true });
    await a.update({ code: v.code, name: v.name, account_type: v.account_type, normal_balance: normal, parent_id: v.parent_id, is_cash: v.is_cash, description: v.description });
    await audit(req, { action: "account_updated", module: "accounting", recordType: "account", recordId: id, previous: prev, next: v });
    return a;
  }
  const a = await ChartOfAccount.create({ code: v.code, name: v.name, account_type: v.account_type, normal_balance: normal, parent_id: v.parent_id, is_cash: v.is_cash, description: v.description, is_system: 0, is_active: 1 });
  await audit(req, { action: "account_created", module: "accounting", recordType: "account", recordId: a.id, next: v });
  return a;
}

export async function toggleAccount(req, id) {
  const a = await ChartOfAccount.findByPk(id);
  if (!a) throw notFound("Account not found.");
  if (a.is_system && a.is_active) throw badRequest("System accounts are used by automatic postings and cannot be deactivated.");
  await a.update({ is_active: !a.is_active });
  await audit(req, { action: a.is_active ? "account_activated" : "account_deactivated", module: "accounting", recordType: "account", recordId: id });
  return a;
}

// ---- categories ---------------------------------------------------------------------------------------------------------------
export const listCategories = (type = null) => select(
  `SELECT c.*, a.code AS account_code, a.name AS account_name FROM transaction_categories c JOIN chart_of_accounts a ON a.id = c.default_account_id ${type ? "WHERE c.category_type = ? AND c.is_active = 1" : ""} ORDER BY c.category_type, c.name`, type ? [type] : []);

export async function addCategory(req, v) {
  const acct = await selectOne("SELECT id, account_type FROM chart_of_accounts WHERE id = ? AND is_active = 1", [v.default_account_id]);
  if (!acct) throw badRequest("Select a valid account.");
  if ((v.category_type === "income") !== (acct.account_type === "revenue") || (v.category_type === "expense") !== (acct.account_type === "expense")) throw badRequest("Income categories need a revenue account and expense categories an expense account.");
  if (await TransactionCategory.findOne({ where: { category_type: v.category_type, name: v.name }, raw: true })) throw badRequest("This category already exists.");
  const c = await TransactionCategory.create({ ...v, is_active: 1 });
  await audit(req, { action: "category_created", module: "accounting", recordType: "transaction_category", recordId: c.id, next: v });
  return c;
}

export async function toggleCategory(req, id) {
  const c = await TransactionCategory.findByPk(id);
  if (!c) throw notFound("Category not found.");
  await c.update({ is_active: !c.is_active });
  await audit(req, { action: c.is_active ? "category_activated" : "category_deactivated", module: "accounting", recordType: "transaction_category", recordId: id });
  return c;
}

// ---- income & expense ------------------------------------------------------------------------------------------------------------
export async function listTransactions(req, type) {
  const t = tableState(req, { sortable: { date: "t.txn_date", amount: "t.amount", status: "t.status" }, defaultSort: "date", defaultDir: "desc" });
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  const from = ok(req.query.from) ? req.query.from : null, to = ok(req.query.to) ? req.query.to : null;
  const category = /^\d+$/.test(req.query.category || "") ? Number(req.query.category) : null;
  const status = ["pending_approval", "posted", "rejected", "voided"].includes(req.query.status) ? req.query.status : null;
  const where = ["t.txn_type = ?"]; const params = [type];
  if (from) { where.push("t.txn_date >= ?"); params.push(from); }
  if (to) { where.push("t.txn_date <= ?"); params.push(to); }
  if (category) { where.push("t.category_id = ?"); params.push(category); }
  if (status) { where.push("t.status = ?"); params.push(status); }
  if (t.q) { where.push("(t.description LIKE ? OR t.txn_no LIKE ? OR t.reference_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.join(" AND ");
  const from_ = "FROM accounting_transactions t LEFT JOIN transaction_categories c ON c.id = t.category_id";
  const total = Number(await scalar(`SELECT COUNT(*) ${from_} WHERE ${W}`, params));
  const sum = await scalar(`SELECT COALESCE(SUM(t.amount),0) ${from_} WHERE ${W} AND t.status = 'posted'`, params);
  const rows = await select(
    `SELECT t.*, c.name AS category_name, u.full_name AS created_by_name, j.entry_no, doc.original_name AS attachment_name
       ${from_} JOIN users u ON u.id = t.created_by LEFT JOIN journal_entries j ON j.id = t.journal_entry_id LEFT JOIN document_attachments doc ON doc.id = t.attachment_id
      WHERE ${W} ORDER BY ${t.orderBy}, t.id DESC LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows, t, from, to, category, status, postedTotal: sum, meta: tableMeta(req, t, total, { from: from || undefined, to: to || undefined, category: category || undefined, status: status || undefined }) };
}

async function postTransaction(req, txn, category, trx) {
  const c = toCents(txn.amount);
  const counter = counterAccount(txn.txn_type, txn.payment_method);
  const je = await postEntry({
    req, date: txn.txn_date, description: `${txn.txn_type === "income" ? "Income" : "Expense"} ${txn.txn_no}: ${txn.description}`,
    sourceType: "accounting_transaction", sourceId: txn.id, sourceEvent: "posting",
    lines: txn.txn_type === "income"
      ? [{ account: counter, debit: c, description: txn.description }, { account: Number(category.default_account_id), credit: c, description: txn.description }]
      : [{ account: Number(category.default_account_id), debit: c, description: txn.description }, { account: counter, credit: c, description: txn.description }],
  }, trx);
  await exec("UPDATE accounting_transactions SET journal_entry_id = ? WHERE id = ?", [je.id, txn.id], trx);
  return je;
}

/** accounting.manage posts immediately; accounting.prepare only creates a request for approval. */
export async function createTransaction(req, type, v, file) {
  return tx(async (trx) => {
    const category = await selectOne("SELECT * FROM transaction_categories WHERE id = ? AND category_type = ? AND is_active = 1", [v.category_id, type], trx);
    if (!category) throw badRequest("Select a valid category.");
    const posts = req.user.can("accounting.manage");
    const no = await nextDocNo(type === "income" ? "INC" : "EXP", 4, trx);
    const { insertId } = await exec(
      `INSERT INTO accounting_transactions (txn_no, txn_type, category_id, txn_date, amount, payment_method, description, reference_no, status, created_by, approved_by, approved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,${posts ? "NOW()" : "NULL"})`,
      [no, type, category.id, v.txn_date, v.amount, v.payment_method, v.description, v.reference_no, posts ? "posted" : "pending_approval", req.user.id, posts ? req.user.id : null], trx);
    const docId = await saveAttachment(req, file, "accounting_transaction", insertId, trx);
    if (docId) await exec("UPDATE accounting_transactions SET attachment_id = ? WHERE id = ?", [docId, insertId], trx);
    const txn = { id: insertId, txn_no: no, txn_type: type, txn_date: v.txn_date, amount: v.amount, payment_method: v.payment_method, description: v.description };
    if (posts) await postTransaction(req, txn, category, trx);
    else await notifyPermission("accounting.adjust.approve", { type: "accounting_pending", title: "Accounting entry awaiting approval", message: `${no}: ${v.description} (₱${v.amount}).`, relatedType: "accounting_transaction", relatedId: insertId, link: "/accounting/approvals" }, { excludeUserId: req.user.id }, trx);
    await audit(req, { action: `${type}_recorded`, module: "accounting", recordType: "accounting_transaction", recordId: insertId, next: { txn_no: no, amount: v.amount, status: posts ? "posted" : "pending_approval" } }, trx);
    return { no, posted: posts };
  });
}

export async function voidTransaction(req, id, reason) {
  if (!reason) throw badRequest("A reason is required to void a transaction.");
  return tx(async (trx) => {
    const t = await selectOne("SELECT * FROM accounting_transactions WHERE id = ? FOR UPDATE", [id], trx);
    if (!t) throw notFound("Transaction not found.");
    if (t.status !== "posted") throw badRequest("Only posted transactions can be voided.");
    await reverseEntry(req, t.journal_entry_id, `${t.txn_no} voided: ${reason}`, trx);
    await exec("UPDATE accounting_transactions SET status = 'voided', voided_by = ?, voided_at = NOW(), void_reason = ? WHERE id = ?", [req.user.id, reason, id], trx);
    await audit(req, { action: "transaction_voided", module: "accounting", recordType: "accounting_transaction", recordId: id, remarks: reason, next: { txn_no: t.txn_no, amount: t.amount } }, trx);
    return t;
  });
}

// ---- adjustments & approvals -----------------------------------------------------------------------------------------------------
/** lines = [{ account_id, debit, credit, description }] as money strings. Stays a draft journal until approved. */
export async function createAdjustment(req, { txn_date, description, lines }) {
  const clean = lines.map((l) => ({ account: Number(l.account_id), debit: toCents(l.debit || 0), credit: toCents(l.credit || 0), description: l.description || null })).filter((l) => l.debit || l.credit);
  if (clean.length < 2) throw badRequest("An adjustment needs at least two lines.");
  if (clean.some((l) => l.debit && l.credit)) throw badRequest("A line can have a debit or a credit, not both.");
  const dr = clean.reduce((a, l) => a + l.debit, 0), cr = clean.reduce((a, l) => a + l.credit, 0);
  if (dr !== cr) throw badRequest(`Debits (${fromCents(dr)}) must equal credits (${fromCents(cr)}).`);
  return tx(async (trx) => {
    const no = await nextDocNo("ADJ", 4, trx);
    const je = await createDraft({ req, date: txn_date, description: `Adjustment ${no}: ${description}`, lines: clean }, trx);
    const { insertId } = await exec(
      `INSERT INTO accounting_transactions (txn_no, txn_type, category_id, txn_date, amount, payment_method, description, status, journal_entry_id, created_by)
       VALUES (?, 'adjustment', NULL, ?, ?, 'cash', ?, 'pending_approval', ?, ?)`, [no, txn_date, fromCents(dr), description, je.id, req.user.id], trx);
    await audit(req, { action: "adjustment_submitted", module: "accounting", recordType: "accounting_transaction", recordId: insertId, next: { txn_no: no, amount: fromCents(dr) } }, trx);
    await notifyPermission("accounting.adjust.approve", { type: "accounting_pending", title: "Accounting adjustment awaiting approval", message: `${no}: ${description}`, relatedType: "accounting_transaction", relatedId: insertId, link: "/accounting/approvals" }, { excludeUserId: req.user.id }, trx);
    return no;
  });
}

export const pendingApprovals = () => select(
  `SELECT t.*, c.name AS category_name, u.full_name AS created_by_name, j.entry_no, doc.original_name AS attachment_name
     FROM accounting_transactions t LEFT JOIN transaction_categories c ON c.id = t.category_id JOIN users u ON u.id = t.created_by
     LEFT JOIN journal_entries j ON j.id = t.journal_entry_id LEFT JOIN document_attachments doc ON doc.id = t.attachment_id
    WHERE t.status = 'pending_approval' ORDER BY t.id`);

export async function decideTransaction(req, id, action, remarks) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting.");
  return tx(async (trx) => {
    const t = await selectOne("SELECT * FROM accounting_transactions WHERE id = ? FOR UPDATE", [id], trx);
    if (!t) throw notFound("Transaction not found.");
    if (t.status !== "pending_approval") throw badRequest(`This entry is already ${t.status}.`);
    if (t.created_by === req.user.id) throw forbidden("You cannot approve an entry you prepared.");
    if (action === "approved") {
      if (t.txn_type === "adjustment") await postDraft(req, t.journal_entry_id, trx);
      else await postTransaction(req, t, await selectOne("SELECT * FROM transaction_categories WHERE id = ?", [t.category_id], trx), trx);
    }
    await exec("UPDATE accounting_transactions SET status = ?, approved_by = ?, approved_at = NOW(), decision_remarks = ? WHERE id = ?", [action === "approved" ? "posted" : "rejected", req.user.id, remarks || null, id], trx);
    await audit(req, { action: `accounting_entry_${action}`, module: "accounting", recordType: "accounting_transaction", recordId: id, decision: action, remarks, next: { txn_no: t.txn_no, amount: t.amount } }, trx);
    await notify(t.created_by, { type: `accounting_${action}`, title: `Accounting entry ${action}`, message: `${t.txn_no} was ${action}${remarks ? `: ${remarks}` : "."}`, relatedType: "accounting_transaction", relatedId: id }, trx);
    return t;
  });
}

// ---- journals ------------------------------------------------------------------------------------------------------------------
export async function listJournals(req) {
  const t = tableState(req, { sortable: { date: "j.entry_date", no: "j.id", amount: "j.total_debit" }, defaultSort: "date", defaultDir: "desc", perPage: 25 });
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  const from = ok(req.query.from) ? req.query.from : null, to = ok(req.query.to) ? req.query.to : null;
  const status = ["draft", "posted", "reversed"].includes(req.query.status) ? req.query.status : null;
  const where = []; const params = [];
  if (from) { where.push("j.entry_date >= ?"); params.push(from); }
  if (to) { where.push("j.entry_date <= ?"); params.push(to); }
  if (status) { where.push("j.status = ?"); params.push(status); }
  if (t.q) { where.push("(j.entry_no LIKE ? OR j.description LIKE ?)"); const l = likeTerm(t.q); params.push(l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM journal_entries j ${W}`, params));
  const rows = await select(`SELECT j.* FROM journal_entries j ${W} ORDER BY ${t.orderBy}, j.id DESC LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows, t, from, to, status, meta: tableMeta(req, t, total, { from: from || undefined, to: to || undefined, status: status || undefined }) };
}

export async function getJournal(id) {
  const j = await selectOne(
    `SELECT j.*, c.full_name AS created_by_name, p.full_name AS posted_by_name, o.entry_no AS reverses_no, (SELECT r.entry_no FROM journal_entries r WHERE r.reverses_entry_id = j.id LIMIT 1) AS reversed_by_no,
            (SELECT r.id FROM journal_entries r WHERE r.reverses_entry_id = j.id LIMIT 1) AS reversed_by_id
       FROM journal_entries j JOIN users c ON c.id = j.created_by LEFT JOIN users p ON p.id = j.posted_by LEFT JOIN journal_entries o ON o.id = j.reverses_entry_id WHERE j.id = ?`, [id]);
  if (!j) throw notFound("Journal entry not found.");
  j.lines = await select("SELECT l.*, a.code, a.name FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no", [id]);
  return j;
}

// ---- financial periods --------------------------------------------------------------------------------------------------------
export const listFinancialPeriods = () => select(
  `SELECT f.*, u.full_name AS closed_by_name, (SELECT COUNT(*) FROM journal_entries j WHERE j.period_id = f.id AND j.status <> 'draft') AS entries,
          (SELECT COUNT(*) FROM accounting_transactions t WHERE t.status = 'pending_approval' AND t.txn_date BETWEEN f.start_date AND f.end_date) AS pending
     FROM financial_periods f LEFT JOIN users u ON u.id = f.closed_by ORDER BY f.start_date DESC`);

export async function setFinancialPeriod(req, id, status) {
  return tx(async (trx) => {
    const p = await selectOne("SELECT * FROM financial_periods WHERE id = ? FOR UPDATE", [id], trx);
    if (!p) throw notFound("Financial period not found.");
    if (status === "closed" && Number(await scalar("SELECT COUNT(*) FROM accounting_transactions WHERE status = 'pending_approval' AND txn_date BETWEEN ? AND ?", [p.start_date, p.end_date], trx))) throw badRequest("Decide the pending entries in this period before closing it.");
    await exec("UPDATE financial_periods SET status = ?, closed_by = ?, closed_at = ? WHERE id = ?", [status, status === "closed" ? req.user.id : null, status === "closed" ? new Date() : null, id], trx);
    await audit(req, { action: `financial_period_${status === "closed" ? "closed" : "reopened"}`, module: "accounting", recordType: "financial_period", recordId: id, next: { label: p.label } }, trx);
    return p;
  });
}
