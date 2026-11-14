// CRM and Inventory events (master prompt §X, §XI; docs/API_INTEGRATION.md §2.2–2.3), registered into the inbox.
// CRM owns orders and sales; Inventory owns stock and purchasing; JVzPay records only the money and owns the ledger.
//   SaleCompleted        → Dr Cash (paid) or Accounts Receivable (on account) / Cr Sales Revenue, Dr Sales Discounts, Cr Output VAT
//   SaleCancelled        → reversal of the sale's entry (a receivable with no collections is voided with it)
//   RefundRecorded       → Dr Sales Returns / Cr Cash for the refunded part of a paid sale
//   PurchaseOrderApproved, GoodsReceived → references for three-way matching (no posting)
//   SupplierInvoiceReceived → a supplier invoice waiting for approval, matched against the PO and receipt
//   StockAdjusted        → Dr/Cr Inventory Adjustments against Merchandise Inventory
//   InventoryValuationReported → compared with the Merchandise Inventory balance in the books
import { select, selectOne, exec, scalar } from "../lib/db.js";
import { toCents, fromCents } from "../lib/money.js";
import { postEntry, reverseEntry } from "./journalService.js";
import { registerHandlers, eventFail as fail, eventNeed as need, eventIsDate as isDate, eventStr as str } from "./integrationService.js";
import { createReceivable } from "./receivablesService.js";
import { createInvoice } from "./payablesService.js";

const cents = (v, label) => { const n = Number(v); if (!Number.isFinite(n)) fail(`${label} must be a number.`); return Math.round(n * 100); };
const SYSTEM = null; // postings made by integration events have no signed-in user

async function customerFor(ref, name, trx) {
  const crm = str(ref, 80);
  if (!crm) return (await selectOne("SELECT id FROM customers WHERE crm_ref IS NULL AND name = 'Walk-in customers'", [], trx))
    || { id: (await exec("INSERT INTO customers (name) VALUES ('Walk-in customers')", [], trx)).insertId };
  const cur = await selectOne("SELECT id FROM customers WHERE crm_ref = ?", [crm], trx);
  if (cur) return cur;
  const { insertId } = await exec("INSERT INTO customers (name, crm_ref) VALUES (?,?)", [str(name, 160) || `CRM customer ${crm}`, crm], trx);
  return { id: insertId };
}

async function saleCompleted(d, e, trx) {
  need(d, ["transaction_id", "transaction_date", "payment_status", "lines", "total_amount"]);
  if (!isDate(d.transaction_date)) fail("data.transaction_date must be YYYY-MM-DD.");
  if (!["paid", "on_account"].includes(d.payment_status)) fail("data.payment_status must be paid or on_account.");
  if (!Array.isArray(d.lines) || !d.lines.length) fail("data.lines must list at least one item.");
  if (await selectOne("SELECT id FROM sales_imports WHERE transaction_id = ?", [str(d.transaction_id, 80)], trx)) fail(`Sale ${d.transaction_id} is already recorded.`);
  let gross = 0, discount = 0, tax = 0;
  for (const [i, l] of d.lines.entries()) {
    const q = Number(l.quantity);
    if (!(q > 0)) fail(`lines[${i}].quantity must be more than 0.`);
    gross += Math.round(q * cents(l.unit_price, `lines[${i}].unit_price`));
    discount += l.discount ? cents(l.discount, `lines[${i}].discount`) : 0;
    tax += l.tax ? cents(l.tax, `lines[${i}].tax`) : 0;
  }
  const total = cents(d.total_amount, "total_amount");
  if (Math.abs(gross - discount + tax - total) > 1) fail(`total_amount ${fromCents(total)} does not equal the lines (${fromCents(gross - discount + tax)}).`);
  if (total <= 0) fail("total_amount must be more than 0.");
  const debitAccount = d.payment_status === "paid" ? "1010" : "1100";
  const je = await postEntry({ req: SYSTEM, date: d.transaction_date, description: `CRM sale ${d.transaction_id}${d.order_id ? ` (order ${d.order_id})` : ""}`, sourceType: "crm_sale", sourceId: null,
    lines: [
      { account: debitAccount, debit: total, description: d.payment_status === "paid" ? `${d.payment_method || "payment"} received` : "Sold on account" },
      { account: "4030", debit: discount, description: "Discounts" },
      { account: "4010", credit: gross, description: "Sales" },
      { account: "2300", credit: tax, description: "Output VAT" },
    ] }, trx);
  let receivableId = null;
  if (d.payment_status === "on_account") {
    const cust = await customerFor(d.customer_ref, d.customer_name, trx);
    const sales = await selectOne("SELECT id FROM chart_of_accounts WHERE code = '4010'", [], trx);
    const due = isDate(d.due_date) ? d.due_date : new Date(new Date(`${d.transaction_date}T00:00:00`).getTime() + 30 * 864e5).toISOString().slice(0, 10);
    const ar = await createReceivable(SYSTEM, { customer_id: cust.id, invoice_date: d.transaction_date, due_date: due, amount: fromCents(total), revenue_account_id: sales.id, description: `CRM sale ${d.transaction_id}` }, trx, { source: "crm", crmTransactionId: str(d.transaction_id, 80), post: false });
    await exec("UPDATE accounts_receivable SET journal_entry_id = ? WHERE id = ?", [je.id, ar.id], trx);
    receivableId = ar.id;
  }
  await exec(
    `INSERT INTO sales_imports (transaction_id, order_id, customer_ref, transaction_date, payment_status, gross_amount, discount_amount, tax_amount, total_amount, line_items, journal_entry_id, receivable_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [str(d.transaction_id, 80), str(d.order_id, 80), str(d.customer_ref, 80), d.transaction_date, d.payment_status, fromCents(gross), fromCents(discount), fromCents(tax), fromCents(total), JSON.stringify(d.lines), je.id, receivableId], trx);
  return `sale ${d.transaction_id} posted as ${je.entryNo}`;
}

async function saleCancelled(d, e, trx) {
  need(d, ["transaction_id"]);
  const s = await selectOne("SELECT * FROM sales_imports WHERE transaction_id = ? FOR UPDATE", [str(d.transaction_id, 80)], trx);
  if (!s) fail(`Sale ${d.transaction_id} is not recorded in JVzPay.`);
  if (s.status !== "posted") fail(`Sale ${d.transaction_id} is already ${s.status.replace("_", " ")}; only an untouched sale can be cancelled.`);
  if (s.receivable_id) {
    const ar = await selectOne("SELECT amount_collected FROM accounts_receivable WHERE id = ?", [s.receivable_id], trx);
    if (toCents(ar.amount_collected) > 0) fail("Part of this sale was already collected; record a refund in CRM instead.");
    await exec("UPDATE accounts_receivable SET status = 'voided' WHERE id = ?", [s.receivable_id], trx);
  }
  const rev = await reverseEntry(SYSTEM, s.journal_entry_id, `CRM cancelled sale ${d.transaction_id}${d.reason ? `: ${str(d.reason, 120)}` : ""}`, trx, isDate(d.date) ? d.date : null);
  await exec("UPDATE sales_imports SET status = 'cancelled' WHERE id = ?", [s.id], trx);
  return `sale ${d.transaction_id} reversed${rev?.entryNo ? ` (${rev.entryNo})` : ""}`;
}

async function refundRecorded(d, e, trx) {
  need(d, ["transaction_id", "amount", "date"]);
  if (!isDate(d.date)) fail("data.date must be YYYY-MM-DD.");
  const s = await selectOne("SELECT * FROM sales_imports WHERE transaction_id = ? FOR UPDATE", [str(d.transaction_id, 80)], trx);
  if (!s) fail(`Sale ${d.transaction_id} is not recorded in JVzPay.`);
  if (s.payment_status !== "paid") fail("Refunds apply to paid sales; cancel an on-account sale instead.");
  if (["cancelled", "refunded"].includes(s.status)) fail(`Sale ${d.transaction_id} is already ${s.status}.`);
  const amt = cents(d.amount, "amount"), left = toCents(s.total_amount) - toCents(s.refunded_amount);
  if (amt <= 0 || amt > left) fail(`The refund must be between 0.01 and ${fromCents(left)}.`);
  const je = await postEntry({ req: SYSTEM, date: d.date, description: `CRM refund on sale ${d.transaction_id}${d.reason ? `: ${str(d.reason, 120)}` : ""}`, sourceType: "crm_refund", sourceId: null,
    lines: [{ account: "4030", debit: amt, description: "Sales return / refund" }, { account: "1010", credit: amt, description: "Refund paid" }] }, trx);
  const refunded = toCents(s.refunded_amount) + amt;
  await exec("UPDATE sales_imports SET refunded_amount = ?, status = ? WHERE id = ?", [fromCents(refunded), refunded >= toCents(s.total_amount) ? "refunded" : "partially_refunded", s.id], trx);
  return `refund of ${fromCents(amt)} posted as ${je.entryNo}`;
}

async function supplierFor(ref, name, trx) {
  const r = str(ref, 80);
  if (!r) fail("data.supplier_ref is required.");
  const cur = await selectOne("SELECT id FROM suppliers WHERE inventory_ref = ?", [r], trx);
  if (cur) return cur;
  const label = str(name, 160) || `Supplier ${r}`;
  const byName = await selectOne("SELECT id FROM suppliers WHERE name = ? AND inventory_ref IS NULL", [label], trx);
  if (byName) { await exec("UPDATE suppliers SET inventory_ref = ? WHERE id = ?", [r, byName.id], trx); return byName; }
  return { id: (await exec("INSERT INTO suppliers (name, inventory_ref) VALUES (?,?)", [label, r], trx)).insertId };
}

const lineTotal = (lines, label) => {
  if (!Array.isArray(lines) || !lines.length) fail(`data.lines must list at least one item (${label}).`);
  return lines.reduce((s, l, i) => { const q = Number(l.quantity); if (!(q > 0)) fail(`lines[${i}].quantity must be more than 0.`); return s + Math.round(q * cents(l.unit_cost, `lines[${i}].unit_cost`)); }, 0);
};

async function purchaseOrder(d, e, trx) {
  need(d, ["purchase_order_id", "supplier_ref", "order_date", "lines", "total_amount"]);
  if (!isDate(d.order_date)) fail("data.order_date must be YYYY-MM-DD.");
  const total = cents(d.total_amount, "total_amount");
  if (Math.abs(lineTotal(d.lines, "purchase order") - total) > 1) fail("total_amount does not equal the lines.");
  const sup = await supplierFor(d.supplier_ref, d.supplier_name, trx);
  await exec(`INSERT INTO purchase_order_references (purchase_order_id, supplier_id, order_date, total_amount, line_items) VALUES (?,?,?,?,?)
              ON DUPLICATE KEY UPDATE total_amount = VALUES(total_amount), line_items = VALUES(line_items)`, [str(d.purchase_order_id, 80), sup.id, d.order_date, fromCents(total), JSON.stringify(d.lines)], trx);
  return `purchase order ${d.purchase_order_id} recorded`;
}

async function goodsReceived(d, e, trx) {
  need(d, ["goods_receipt_id", "purchase_order_id", "received_date", "lines", "total_amount"]);
  if (!isDate(d.received_date)) fail("data.received_date must be YYYY-MM-DD.");
  if (!(await selectOne("SELECT id FROM purchase_order_references WHERE purchase_order_id = ?", [str(d.purchase_order_id, 80)], trx))) fail(`Purchase order ${d.purchase_order_id} is not known yet. Send PurchaseOrderApproved first.`);
  const total = cents(d.total_amount, "total_amount");
  if (Math.abs(lineTotal(d.lines, "goods receipt") - total) > 1) fail("total_amount does not equal the lines.");
  await exec("INSERT INTO goods_receipt_references (goods_receipt_id, purchase_order_id, received_date, total_amount, line_items) VALUES (?,?,?,?,?)",
    [str(d.goods_receipt_id, 80), str(d.purchase_order_id, 80), d.received_date, fromCents(total), JSON.stringify(d.lines)], trx);
  return `goods receipt ${d.goods_receipt_id} recorded`;
}

async function supplierInvoice(d, e, trx) {
  need(d, ["supplier_invoice_no", "purchase_order_id", "invoice_date", "amount"]);
  if (!isDate(d.invoice_date) || (d.due_date && !isDate(d.due_date))) fail("Dates must be YYYY-MM-DD.");
  const po = await selectOne("SELECT supplier_id FROM purchase_order_references WHERE purchase_order_id = ?", [str(d.purchase_order_id, 80)], trx);
  if (!po) fail(`Purchase order ${d.purchase_order_id} is not known yet.`);
  const inv = await selectOne("SELECT id FROM chart_of_accounts WHERE code = '1200'", [], trx);
  const r = await createInvoice(SYSTEM, {
    supplier_id: po.supplier_id, invoice_no: str(d.supplier_invoice_no, 60), invoice_date: d.invoice_date, due_date: d.due_date || "", amount: fromCents(cents(d.amount, "amount")),
    debit_account_id: inv.id, description: `Merchandise per PO ${d.purchase_order_id}`, purchase_order_ref: str(d.purchase_order_id, 80), goods_receipt_ref: str(d.goods_receipt_id, 80),
  }, null, { source: "inventory" }, trx);
  return `supplier invoice ${r.no} waiting for approval (${r.match.status})`;
}

async function stockAdjusted(d, e, trx) {
  need(d, ["adjustment_id", "date", "amount", "reason"]);
  if (!isDate(d.date)) fail("data.date must be YYYY-MM-DD.");
  const amt = cents(d.amount, "amount");
  if (amt === 0) fail("amount cannot be 0.");
  const abs = Math.abs(amt);
  const je = await postEntry({ req: SYSTEM, date: d.date, description: `Inventory adjustment ${d.adjustment_id}: ${str(d.reason, 150)}`, sourceType: "stock_adjustment", sourceId: null,
    lines: amt < 0
      ? [{ account: "5050", debit: abs, description: "Stock loss" }, { account: "1200", credit: abs, description: "Merchandise inventory" }]
      : [{ account: "1200", debit: abs, description: "Merchandise inventory" }, { account: "5050", credit: abs, description: "Stock gain" }] }, trx);
  return `stock adjustment ${d.adjustment_id} posted as ${je.entryNo}`;
}

async function valuation(d) {
  need(d, ["as_of", "total_value"]);
  const books = Number(await scalar(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id AND j.status IN ('posted','reversed')
       JOIN chart_of_accounts a ON a.id = l.account_id AND a.code = '1200' WHERE j.entry_date <= ?`, [d.as_of]));
  const diff = cents(d.total_value, "total_value") - Math.round(books * 100);
  return `valuation ${d.total_value} vs books ${books.toFixed(2)}${diff ? ` (difference ${fromCents(diff)})` : " (agrees)"}`;
}

registerHandlers("johnvivz_crm", { SaleCompleted: saleCompleted, SaleCancelled: saleCancelled, RefundRecorded: refundRecorded });
registerHandlers("johnvivz_inventory", { PurchaseOrderApproved: purchaseOrder, GoodsReceived: goodsReceived, SupplierInvoiceReceived: supplierInvoice, StockAdjusted: stockAdjusted, InventoryValuationReported: valuation });
export const listSales = () => select("SELECT * FROM sales_imports ORDER BY transaction_date DESC, id DESC LIMIT 100");
