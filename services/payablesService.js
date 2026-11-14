// Accounts payable (master prompt §IX, §XI): suppliers, supplier invoices and supplier payments.
// Accounting Staff record an invoice → the Accounting Supervisor approves it → it posts Dr <what was bought> / Cr Accounts
// Payable and becomes an open payable → payments post Dr Accounts Payable / Cr Cash. Invoices tied to an Inventory
// purchase order are three-way matched (PO, goods receipt, invoice) before they may be approved. Voids post reversals.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { nextDocNo } from "../lib/sequence.js";
import { toCents, fromCents } from "../lib/money.js";
import { notifyPermission, notify } from "../lib/notify.js";
import { saveAttachment } from "../middleware/upload.js";
import { badRequest, notFound, forbidden } from "../lib/errors.js";
import { postEntry, reverseEntry } from "./journalService.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";

export const PAY_METHODS = ["cash", "bank_transfer", "check", "e_wallet"];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const money = (v) => { const s = String(v ?? "").replace(/[,\s₱]/g, ""); return /^\d+(\.\d{1,2})?$/.test(s) ? s : null; };

// ---- suppliers ---------------------------------------------------------------------------------------------------------------
export const listSuppliers = () => select(`SELECT s.*, (SELECT COALESCE(SUM(amount - amount_paid), 0) FROM supplier_invoices i WHERE i.supplier_id = s.id AND i.status IN ('unpaid','partially_paid')) AS balance
                                              FROM suppliers s ORDER BY s.is_active DESC, s.name`);

export async function saveSupplier(req, body) {
  const v = { name: String(body.name || "").trim().slice(0, 160), contact_person: String(body.contact_person || "").trim().slice(0, 120) || null, phone: String(body.phone || "").trim().slice(0, 40) || null,
    email: String(body.email || "").trim().toLowerCase().slice(0, 190) || null, address: String(body.address || "").trim().slice(0, 255) || null, payment_terms_days: Number(body.payment_terms_days || 30) };
  const errors = {};
  if (!v.name) errors.name = "Enter the supplier's name.";
  if (!Number.isInteger(v.payment_terms_days) || v.payment_terms_days < 0 || v.payment_terms_days > 365) errors.payment_terms_days = "Payment terms are 0–365 days.";
  if (Object.keys(errors).length) return { errors, values: v };
  if (await selectOne("SELECT id FROM suppliers WHERE name = ?", [v.name])) return { errors: { name: "A supplier with this name already exists." }, values: v };
  const { insertId } = await exec("INSERT INTO suppliers (name, contact_person, phone, email, address, payment_terms_days) VALUES (?,?,?,?,?,?)", Object.values(v));
  await audit(req, { action: "supplier_created", module: "accounting", recordType: "supplier", recordId: insertId, next: v });
  return { id: insertId };
}

// ---- supplier invoices ----------------------------------------------------------------------------------------------------
export function checkInvoice(body) {
  const v = { supplier_id: Number(body.supplier_id), invoice_no: String(body.invoice_no || "").trim().slice(0, 60), invoice_date: String(body.invoice_date || ""), due_date: String(body.due_date || ""),
    amount: money(body.amount), debit_account_id: Number(body.debit_account_id), description: String(body.description || "").trim().slice(0, 255),
    purchase_order_ref: String(body.purchase_order_ref || "").trim().slice(0, 80) || null, goods_receipt_ref: String(body.goods_receipt_ref || "").trim().slice(0, 80) || null };
  const errors = {};
  if (!v.supplier_id) errors.supplier_id = "Choose the supplier.";
  if (!v.invoice_no) errors.invoice_no = "Enter the supplier's invoice number.";
  if (!isDate(v.invoice_date)) errors.invoice_date = "Enter the invoice date.";
  if (v.due_date && !isDate(v.due_date)) errors.due_date = "Enter a valid due date.";
  if (!v.amount || Number(v.amount) <= 0) errors.amount = "Enter the amount (e.g. 12500.00).";
  if (!v.debit_account_id) errors.debit_account_id = "Choose what was bought.";
  if (!v.description) errors.description = "Describe the invoice.";
  return { values: v, errors };
}

/** Three-way match: the purchase order and goods receipt from Inventory must exist and agree with the invoice amount. */
async function threeWayMatch(v, trx) {
  if (!v.purchase_order_ref) return { status: "not_applicable", note: null };
  const po = await selectOne("SELECT * FROM purchase_order_references WHERE purchase_order_id = ?", [v.purchase_order_ref], trx);
  if (!po) return { status: "unmatched", note: `Purchase order ${v.purchase_order_ref} has not been received from Inventory.` };
  if (po.supplier_id !== v.supplier_id) return { status: "unmatched", note: "The purchase order belongs to a different supplier." };
  const gr = v.goods_receipt_ref
    ? await selectOne("SELECT * FROM goods_receipt_references WHERE goods_receipt_id = ? AND purchase_order_id = ?", [v.goods_receipt_ref, v.purchase_order_ref], trx)
    : await selectOne("SELECT purchase_order_id, SUM(total_amount) AS total_amount FROM goods_receipt_references WHERE purchase_order_id = ? GROUP BY purchase_order_id", [v.purchase_order_ref], trx);
  if (!gr) return { status: "unmatched", note: "No goods receipt for this purchase order yet." };
  if (toCents(gr.total_amount) !== toCents(v.amount)) return { status: "unmatched", note: `Invoice ₱${v.amount} differs from goods received ₱${gr.total_amount}.` };
  if (toCents(v.amount) > toCents(po.total_amount)) return { status: "unmatched", note: `Invoice is more than the purchase order (₱${po.total_amount}).` };
  return { status: "matched", note: `PO ${po.purchase_order_id} and receipt agree.` };
}

export async function createInvoice(req, v, file, { source = "manual" } = {}, trxIn = null) {
  const run = async (trx) => {
    const sup = await selectOne("SELECT * FROM suppliers WHERE id = ? AND is_active = 1", [v.supplier_id], trx);
    if (!sup) throw badRequest("Choose an active supplier.");
    const acct = await selectOne("SELECT id, account_type FROM chart_of_accounts WHERE id = ? AND is_active = 1", [v.debit_account_id], trx);
    if (!acct || !["asset", "expense"].includes(acct.account_type)) throw badRequest("Choose an expense or inventory account.");
    if (await selectOne("SELECT id FROM supplier_invoices WHERE supplier_id = ? AND invoice_no = ?", [v.supplier_id, v.invoice_no], trx))
      throw badRequest(`Invoice ${v.invoice_no} from this supplier is already recorded.`);
    const due = v.due_date || new Date(new Date(`${v.invoice_date}T00:00:00`).getTime() + sup.payment_terms_days * 864e5).toISOString().slice(0, 10);
    if (due < v.invoice_date) throw badRequest("The due date cannot be before the invoice date.");
    const match = await threeWayMatch(v, trx);
    const no = await nextDocNo("SI", 4, trx);
    const { insertId } = await exec(
      `INSERT INTO supplier_invoices (internal_no, supplier_id, invoice_no, invoice_date, due_date, amount, debit_account_id, description, purchase_order_ref, goods_receipt_ref, match_status, match_note, source, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [no, v.supplier_id, v.invoice_no, v.invoice_date, due, v.amount, v.debit_account_id, v.description, v.purchase_order_ref, v.goods_receipt_ref, match.status, match.note, source, req?.user?.id ?? null], trx);
    if (file) { const doc = await saveAttachment(req, file, "supplier_invoice", insertId, trx); if (doc) await exec("UPDATE supplier_invoices SET attachment_id = ? WHERE id = ?", [doc, insertId], trx); }
    await audit(req, { action: "supplier_invoice_recorded", module: "accounting", recordType: "supplier_invoice", recordId: insertId, next: { internal_no: no, supplier: sup.name, invoice_no: v.invoice_no, amount: v.amount, match: match.status } }, trx);
    await notifyPermission("payables.approve", { type: "supplier_invoice", title: "Supplier invoice awaiting approval", message: `${no}: ${sup.name} invoice ${v.invoice_no}, ₱${v.amount}${match.status === "unmatched" ? " (does not match Inventory)" : ""}.`, relatedType: "supplier_invoice", relatedId: insertId, link: "/accounting/payables" }, { excludeUserId: req?.user?.id ?? null }, trx);
    return { id: insertId, no, match };
  };
  return trxIn ? run(trxIn) : tx(run);
}

export async function listInvoices(req) {
  const t = tableState(req, { sortable: { due: "i.due_date", date: "i.invoice_date", amount: "i.amount", status: "i.status" }, defaultSort: "due", defaultDir: "asc" });
  const status = ["pending_approval", "unpaid", "partially_paid", "paid", "rejected", "voided", "open"].includes(req.query.status) ? req.query.status : "";
  const where = [], params = [];
  if (status === "open") where.push("i.status IN ('unpaid','partially_paid')");
  else if (status) { where.push("i.status = ?"); params.push(status); }
  if (t.q) { where.push("(s.name LIKE ? OR i.invoice_no LIKE ? OR i.internal_no LIKE ? OR i.description LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l, l); }
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id ${W}`, params));
  const rows = await select(
    `SELECT i.*, s.name AS supplier_name, a.code AS account_code, a.name AS account_name, u.full_name AS created_by_name, (i.amount - i.amount_paid) AS balance,
            (i.status IN ('unpaid','partially_paid') AND i.due_date < CURDATE()) AS overdue
       FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id JOIN chart_of_accounts a ON a.id = i.debit_account_id LEFT JOIN users u ON u.id = i.created_by
      ${W} ORDER BY ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  const totals = await selectOne(`SELECT COALESCE(SUM(amount - amount_paid), 0) AS open, COALESCE(SUM(CASE WHEN due_date < CURDATE() THEN amount - amount_paid END), 0) AS overdue, COUNT(*) AS n
                                    FROM supplier_invoices WHERE status IN ('unpaid','partially_paid')`);
  return { rows, status, totals, t, meta: tableMeta(req, t, total, { status: status || undefined }) };
}

export async function decideInvoice(req, id, action, remarks) {
  if (!["approve", "reject"].includes(action)) throw badRequest("Choose approve or reject.");
  const why = String(remarks || "").trim().slice(0, 500);
  if (action === "reject" && !why) throw badRequest("Give a reason for rejecting it.");
  return tx(async (trx) => {
    const i = await selectOne("SELECT i.*, s.name AS supplier_name FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ? FOR UPDATE", [id], trx);
    if (!i) throw notFound("Invoice not found.");
    if (i.status !== "pending_approval") throw badRequest("This invoice has already been decided.");
    if (i.created_by && i.created_by === req.user.id) throw forbidden("You cannot approve an invoice you recorded. Another Accounting Supervisor must.");
    if (action === "approve" && i.match_status === "unmatched") throw badRequest(`It cannot be approved until it matches Inventory: ${i.match_note}`);
    if (action === "reject") {
      await exec("UPDATE supplier_invoices SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [req.user.id, why, id], trx);
    } else {
      const c = toCents(i.amount);
      const je = await postEntry({ req, date: String(i.invoice_date instanceof Date ? i.invoice_date.toISOString() : i.invoice_date).slice(0, 10), description: `${i.internal_no}: ${i.supplier_name} invoice ${i.invoice_no}`, sourceType: "supplier_invoice", sourceId: i.id,
        lines: [{ account: Number(i.debit_account_id), debit: c, description: i.description }, { account: "2010", credit: c, description: `Payable to ${i.supplier_name}` }] }, trx);
      await exec("UPDATE supplier_invoices SET status = 'unpaid', journal_entry_id = ?, decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [je.id, req.user.id, why || null, id], trx);
    }
    await audit(req, { action: `supplier_invoice_${action === "approve" ? "approved" : "rejected"}`, module: "accounting", recordType: "supplier_invoice", recordId: id, decision: action === "approve" ? "approved" : "rejected", remarks: why || null }, trx);
    if (i.created_by) await notify(i.created_by, { type: "supplier_invoice_decided", title: `Supplier invoice ${action === "approve" ? "approved" : "rejected"}`, message: `${i.internal_no} (${i.supplier_name})${why ? `: ${why}` : ""}`, relatedType: "supplier_invoice", relatedId: id, link: "/accounting/payables" }, trx);
  });
}

export function checkPayment(body) {
  const v = { amount: money(body.amount), payment_date: String(body.payment_date || ""), cash_account_id: Number(body.cash_account_id), method: String(body.method || ""), reference_no: String(body.reference_no || "").trim().slice(0, 80) || null };
  const errors = {};
  if (!v.amount || Number(v.amount) <= 0) errors.amount = "Enter the amount paid.";
  if (!isDate(v.payment_date)) errors.payment_date = "Enter the payment date.";
  if (!v.cash_account_id) errors.cash_account_id = "Choose where the money came from.";
  if (!PAY_METHODS.includes(v.method)) errors.method = "Choose the payment method.";
  return { values: v, errors };
}

export async function payInvoice(req, id, v) {
  return tx(async (trx) => {
    const i = await selectOne("SELECT i.*, s.name AS supplier_name FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ? FOR UPDATE", [id], trx);
    if (!i) throw notFound("Invoice not found.");
    if (!["unpaid", "partially_paid"].includes(i.status)) throw badRequest("Only approved, unpaid invoices can be paid.");
    const balance = toCents(i.amount) - toCents(i.amount_paid);
    const c = toCents(v.amount);
    if (c > balance) throw badRequest(`The payment is more than the balance (₱${fromCents(balance)}).`);
    const cash = await selectOne("SELECT id FROM chart_of_accounts WHERE id = ? AND is_cash = 1 AND is_active = 1", [v.cash_account_id], trx);
    if (!cash) throw badRequest("Pay from a cash or bank account.");
    const no = await nextDocNo("SP", 4, trx);
    const je = await postEntry({ req, date: v.payment_date, description: `${no}: payment to ${i.supplier_name} for ${i.invoice_no}`, sourceType: "supplier_payment", sourceId: null,
      lines: [{ account: "2010", debit: c, description: `${i.internal_no}` }, { account: cash.id, credit: c, description: v.reference_no || v.method }] }, trx);
    await exec("INSERT INTO supplier_payments (payment_no, supplier_invoice_id, payment_date, amount, cash_account_id, method, reference_no, journal_entry_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
      [no, id, v.payment_date, v.amount, cash.id, v.method, v.reference_no, je.id, req.user.id], trx);
    const paid = toCents(i.amount_paid) + c;
    await exec("UPDATE supplier_invoices SET amount_paid = ?, status = ? WHERE id = ?", [fromCents(paid), paid >= toCents(i.amount) ? "paid" : "partially_paid", id], trx);
    await audit(req, { action: "supplier_payment_recorded", module: "accounting", recordType: "supplier_invoice", recordId: id, next: { payment_no: no, amount: v.amount, method: v.method } }, trx);
    return no;
  });
}

/** Void an approved invoice that has no payments: its journal entry is reversed, never deleted. */
export async function voidInvoice(req, id, reason) {
  const why = String(reason || "").trim().slice(0, 300);
  if (!why) throw badRequest("Give a reason for voiding it.");
  return tx(async (trx) => {
    const i = await selectOne("SELECT * FROM supplier_invoices WHERE id = ? FOR UPDATE", [id], trx);
    if (!i) throw notFound("Invoice not found.");
    if (i.status !== "unpaid" || toCents(i.amount_paid) > 0) throw badRequest("Only an approved invoice with no payments can be voided.");
    await reverseEntry(req, i.journal_entry_id, why, trx);
    await exec("UPDATE supplier_invoices SET status = 'voided', decision_remarks = ? WHERE id = ?", [why, id], trx);
    await audit(req, { action: "supplier_invoice_voided", module: "accounting", recordType: "supplier_invoice", recordId: id, remarks: why }, trx);
  });
}

export const invoicePayments = (id) => select("SELECT p.*, a.name AS cash_account FROM supplier_payments p JOIN chart_of_accounts a ON a.id = p.cash_account_id WHERE p.supplier_invoice_id = ? ORDER BY p.id", [id]);
export const cashAccounts = () => select("SELECT id, code, name FROM chart_of_accounts WHERE is_cash = 1 AND is_active = 1 ORDER BY code");
export const purchaseAccounts = () => select("SELECT id, code, name FROM chart_of_accounts WHERE is_active = 1 AND (account_type = 'expense' OR code = '1200') AND code NOT IN ('5010','5020','5030') ORDER BY code");
