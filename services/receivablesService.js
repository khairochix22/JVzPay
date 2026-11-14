// Accounts receivable (master prompt §IX, §X): customers, receivables and collections.
// A receivable posts Dr Accounts Receivable / Cr revenue; a collection posts Dr Cash / Cr Accounts Receivable.
// CRM sales on account create receivables automatically (crmHandlers). Voids post reversals, never deletes.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { nextDocNo } from "../lib/sequence.js";
import { toCents, fromCents } from "../lib/money.js";
import { badRequest, notFound } from "../lib/errors.js";
import { postEntry, reverseEntry } from "./journalService.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const money = (v) => { const s = String(v ?? "").replace(/[,\s₱]/g, ""); return /^\d+(\.\d{1,2})?$/.test(s) ? s : null; };
const d10 = (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

export const listCustomers = () => select(`SELECT c.*, (SELECT COALESCE(SUM(amount - amount_collected), 0) FROM accounts_receivable r WHERE r.customer_id = c.id AND r.status IN ('unpaid','partially_paid')) AS balance
                                              FROM customers c ORDER BY c.is_active DESC, c.name`);

export async function saveCustomer(req, body) {
  const v = { name: String(body.name || "").trim().slice(0, 160), phone: String(body.phone || "").trim().slice(0, 40) || null, email: String(body.email || "").trim().toLowerCase().slice(0, 190) || null, address: String(body.address || "").trim().slice(0, 255) || null };
  if (!v.name) return { errors: { name: "Enter the customer's name." }, values: v };
  const { insertId } = await exec("INSERT INTO customers (name, phone, email, address) VALUES (?,?,?,?)", Object.values(v));
  await audit(req, { action: "customer_created", module: "accounting", recordType: "customer", recordId: insertId, next: { name: v.name } });
  return { id: insertId };
}

export function checkReceivable(body) {
  const v = { customer_id: Number(body.customer_id), invoice_date: String(body.invoice_date || ""), due_date: String(body.due_date || ""), amount: money(body.amount), revenue_account_id: Number(body.revenue_account_id), description: String(body.description || "").trim().slice(0, 255) };
  const errors = {};
  if (!v.customer_id) errors.customer_id = "Choose the customer.";
  if (!isDate(v.invoice_date)) errors.invoice_date = "Enter the invoice date.";
  if (!isDate(v.due_date)) errors.due_date = "Enter the due date.";
  else if (isDate(v.invoice_date) && v.due_date < v.invoice_date) errors.due_date = "The due date cannot be before the invoice date.";
  if (!v.amount || Number(v.amount) <= 0) errors.amount = "Enter the amount.";
  if (!v.revenue_account_id) errors.revenue_account_id = "Choose the revenue account.";
  if (!v.description) errors.description = "Describe what was sold.";
  return { values: v, errors };
}

/** Records and posts a receivable. `source`/`crmTransactionId` are set for CRM sales on account. */
export async function createReceivable(req, v, trx, { source = "manual", crmTransactionId = null, post = true } = {}) {
  const cust = await selectOne("SELECT id, name FROM customers WHERE id = ?", [v.customer_id], trx);
  if (!cust) throw badRequest("Choose a customer.");
  const acct = await selectOne("SELECT id FROM chart_of_accounts WHERE id = ? AND account_type = 'revenue' AND is_active = 1", [v.revenue_account_id], trx);
  if (!acct) throw badRequest("Choose a revenue account.");
  const no = await nextDocNo("AR", 4, trx);
  let jeId = null;
  if (post) {
    const c = toCents(v.amount);
    jeId = (await postEntry({ req, date: v.invoice_date, description: `${no}: ${cust.name} — ${v.description}`, sourceType: "receivable", sourceId: null,
      lines: [{ account: "1100", debit: c, description: cust.name }, { account: acct.id, credit: c, description: v.description }] }, trx)).id;
  }
  const { insertId } = await exec(
    "INSERT INTO accounts_receivable (receivable_no, customer_id, invoice_date, due_date, amount, description, revenue_account_id, source, crm_transaction_id, journal_entry_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [no, cust.id, v.invoice_date, v.due_date, v.amount, v.description, acct.id, source, crmTransactionId, jeId, req?.user?.id ?? null], trx);
  await audit(req, { action: "receivable_recorded", module: "accounting", recordType: "receivable", recordId: insertId, next: { receivable_no: no, customer: cust.name, amount: v.amount, source } }, trx);
  return { id: insertId, no };
}

export async function listReceivables(req) {
  const t = tableState(req, { sortable: { due: "r.due_date", date: "r.invoice_date", amount: "r.amount", status: "r.status" }, defaultSort: "due", defaultDir: "asc" });
  const status = ["unpaid", "partially_paid", "paid", "voided", "open"].includes(req.query.status) ? req.query.status : "";
  const where = [], params = [];
  if (status === "open") where.push("r.status IN ('unpaid','partially_paid')");
  else if (status) { where.push("r.status = ?"); params.push(status); }
  if (t.q) { where.push("(c.name LIKE ? OR r.receivable_no LIKE ? OR r.description LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM accounts_receivable r JOIN customers c ON c.id = r.customer_id ${W}`, params));
  const rows = await select(
    `SELECT r.*, c.name AS customer_name, (r.amount - r.amount_collected) AS balance, (r.status IN ('unpaid','partially_paid') AND r.due_date < CURDATE()) AS overdue
       FROM accounts_receivable r JOIN customers c ON c.id = r.customer_id ${W} ORDER BY ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  // aging of what is still owed: current, 1–30, 31–60, 61–90, over 90 days past due
  const aging = await selectOne(
    `SELECT COALESCE(SUM(CASE WHEN due_date >= CURDATE() THEN amount - amount_collected END), 0) AS current_,
            COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 1 AND 30 THEN amount - amount_collected END), 0) AS d30,
            COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 31 AND 60 THEN amount - amount_collected END), 0) AS d60,
            COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 61 AND 90 THEN amount - amount_collected END), 0) AS d90,
            COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) > 90 THEN amount - amount_collected END), 0) AS over90,
            COALESCE(SUM(amount - amount_collected), 0) AS total
       FROM accounts_receivable WHERE status IN ('unpaid','partially_paid')`);
  return { rows, status, aging, t, meta: tableMeta(req, t, total, { status: status || undefined }) };
}

export async function collect(req, id, v) {
  return tx(async (trx) => {
    const r = await selectOne("SELECT r.*, c.name AS customer_name FROM accounts_receivable r JOIN customers c ON c.id = r.customer_id WHERE r.id = ? FOR UPDATE", [id], trx);
    if (!r) throw notFound("Receivable not found.");
    if (!["unpaid", "partially_paid"].includes(r.status)) throw badRequest("Only open receivables can be collected.");
    const balance = toCents(r.amount) - toCents(r.amount_collected), c = toCents(v.amount);
    if (c > balance) throw badRequest(`The collection is more than the balance (₱${fromCents(balance)}).`);
    const cash = await selectOne("SELECT id FROM chart_of_accounts WHERE id = ? AND is_cash = 1 AND is_active = 1", [v.cash_account_id], trx);
    if (!cash) throw badRequest("Deposit into a cash or bank account.");
    const no = await nextDocNo("CC", 4, trx);
    const je = await postEntry({ req, date: v.payment_date, description: `${no}: collection from ${r.customer_name} for ${r.receivable_no}`, sourceType: "customer_collection", sourceId: null,
      lines: [{ account: cash.id, debit: c, description: v.reference_no || v.method }, { account: "1100", credit: c, description: r.receivable_no }] }, trx);
    await exec("INSERT INTO customer_collections (collection_no, receivable_id, collection_date, amount, cash_account_id, method, reference_no, journal_entry_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
      [no, id, v.payment_date, v.amount, cash.id, v.method, v.reference_no, je.id, req.user.id], trx);
    const got = toCents(r.amount_collected) + c;
    await exec("UPDATE accounts_receivable SET amount_collected = ?, status = ? WHERE id = ?", [fromCents(got), got >= toCents(r.amount) ? "paid" : "partially_paid", id], trx);
    await audit(req, { action: "collection_recorded", module: "accounting", recordType: "receivable", recordId: id, next: { collection_no: no, amount: v.amount } }, trx);
    return no;
  });
}

export async function voidReceivable(req, id, reason, trxIn = null) {
  const why = String(reason || "").trim().slice(0, 300);
  if (!why) throw badRequest("Give a reason for voiding it.");
  const run = async (trx) => {
    const r = await selectOne("SELECT * FROM accounts_receivable WHERE id = ? FOR UPDATE", [id], trx);
    if (!r) throw notFound("Receivable not found.");
    if (r.status !== "unpaid" || toCents(r.amount_collected) > 0) throw badRequest("Only a receivable with no collections can be voided.");
    if (r.journal_entry_id) await reverseEntry(req, r.journal_entry_id, why, trx);
    await exec("UPDATE accounts_receivable SET status = 'voided' WHERE id = ?", [id], trx);
    await audit(req, { action: "receivable_voided", module: "accounting", recordType: "receivable", recordId: id, remarks: why }, trx);
  };
  return trxIn ? run(trxIn) : tx(run);
}

export const revenueAccounts = () => select("SELECT id, code, name FROM chart_of_accounts WHERE account_type = 'revenue' AND is_active = 1 AND normal_balance = 'credit' ORDER BY code");
export { d10 };
