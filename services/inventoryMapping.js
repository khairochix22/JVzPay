// Inventory's events → JVzPay's purchasing handlers. Pure functions, unit-tested.
//
// Inventory does not push events: it keeps them in an outbox that JVzPay polls (GET /accounting/outbox, then
// POST /accounting/outbox/{event_id}/ack). Its event names (team list, 2026-11-16) and what JVzPay does with them:
//   PurchaseOrderApproved   → PurchaseOrderApproved (purchase order reference for three-way matching)
//   GoodsReceiptRecorded    → GoodsReceived (goods receipt reference)
//   PurchaseOrderCreated, PurchaseOrderUpdated, PurchaseOrderCancelled, InventoryReturnReceived, RefundReported
//                           → recorded and acknowledged, no accounting entry yet (to agree between the two teams)
// Events JVzPay can use but Inventory does not send: SupplierInvoiceReceived, StockAdjusted, InventoryValuationReported.
//
// Inventory's exact data fields were not available when this was written: each field accepts JVzPay's documented name
// (docs/API_INTEGRATION.md §2.3) and the usual alternatives. To follow Inventory's final shape, change only this file.
export class InventoryMappingError extends Error {}
const fail = (m) => { throw new InventoryMappingError(m); };
const blank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
function pick(o, ...keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((x, p) => (x && typeof x === "object" ? x[p] : undefined), o);
    if (!blank(v) && typeof v !== "object") return typeof v === "string" ? v.trim() : v;
  }
  return undefined;
}
const date10 = (v) => (blank(v) ? undefined : /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : undefined);

/** Events that are stored and acknowledged without an accounting entry, with the reason shown on the Integration page. */
export const NO_POSTING = {
  PurchaseOrderCreated: "a purchase order is recorded when it is approved (PurchaseOrderApproved)",
  PurchaseOrderUpdated: "changes to a purchase order have no accounting effect until the teams agree on one",
  PurchaseOrderCancelled: "no accounting entry exists for an unreceived purchase order; the teams still have to agree how a cancellation closes the reference",
  InventoryReturnReceived: "returned stock has no agreed accounting entry yet (customer refunds are posted from CRM's RefundRecorded)",
  RefundReported: "refunds are posted once, from CRM's RefundRecorded, so this report is not posted again",
};
/** JVzPay events Inventory does not send (for the two teams to agree on). */
export const NOT_SENT_BY_INVENTORY = ["SupplierInvoiceReceived", "StockAdjusted", "InventoryValuationReported"];

function lines(d) {
  const list = Array.isArray(d.lines) ? d.lines : Array.isArray(d.items) ? d.items : null;
  if (!list || !list.length) fail("the event lists no items");
  return list.map((l, i) => {
    const out = {
      product_ref: pick(l, "product_ref", "product_id", "sku", "product.sku", "product.id"),
      quantity: pick(l, "quantity", "qty", "quantity_received", "received_quantity", "quantity_ordered"),
      unit_cost: pick(l, "unit_cost", "cost", "unit_price", "price"),
    };
    if (out.quantity === undefined || out.unit_cost === undefined) fail(`item ${i + 1} needs a quantity and a unit cost`);
    return out;
  });
}
const total = (d, ls) => pick(d, "total_amount", "total", "grand_total", "total_cost")
  ?? (Math.round(ls.reduce((s, l) => s + Math.round(Number(l.quantity) * Math.round(Number(l.unit_cost) * 100)), 0)) / 100).toFixed(2);

/** Inventory's purchase order → PurchaseOrderApproved data. */
export function mapPurchaseOrder(d) {
  const ls = lines(d);
  const out = {
    purchase_order_id: pick(d, "purchase_order_id", "po_id", "po_number", "purchase_order_no", "id"),
    supplier_ref: pick(d, "supplier_ref", "supplier_id", "supplier.code", "supplier.id", "supplier_code"),
    supplier_name: pick(d, "supplier_name", "supplier.name"),
    order_date: date10(pick(d, "order_date", "po_date", "approved_at", "created_at", "date")),
    lines: ls, total_amount: total(d, ls),
  };
  if (!out.purchase_order_id) fail("the purchase order has no id");
  if (!out.order_date) fail(`purchase order ${out.purchase_order_id} has no order date`);
  return out;
}

/** Inventory's goods receipt → GoodsReceived data. */
export function mapGoodsReceipt(d) {
  const ls = lines(d);
  const out = {
    goods_receipt_id: pick(d, "goods_receipt_id", "receipt_id", "grn_id", "grn_number", "receipt_no", "id"),
    purchase_order_id: pick(d, "purchase_order_id", "po_id", "po_number", "purchase_order_no"),
    received_date: date10(pick(d, "received_date", "received_at", "receipt_date", "date")),
    lines: ls, total_amount: total(d, ls),
  };
  if (!out.goods_receipt_id) fail("the goods receipt has no id");
  if (!out.purchase_order_id) fail(`goods receipt ${out.goods_receipt_id} names no purchase order`);
  if (!out.received_date) fail(`goods receipt ${out.goods_receipt_id} has no received date`);
  return out;
}

/** One item of Inventory's outbox → a JVzPay event envelope (source forced to Inventory). Throws when it cannot be. */
export function envelopeFromOutbox(ev) {
  if (!ev || typeof ev !== "object") fail("an outbox item is not an object");
  const eventId = pick(ev, "event_id", "id", "uuid");
  const type = pick(ev, "event_type", "type", "name");
  if (!eventId) fail("an outbox item has no event_id");
  if (!type) fail(`outbox item ${eventId} has no event_type`);
  if (ev.source && ev.source !== "johnvivz_inventory") fail(`outbox item ${eventId} says it comes from ${ev.source}`);
  const data = ev.data && typeof ev.data === "object" ? ev.data : ev.payload && typeof ev.payload === "object" ? ev.payload : {};
  return {
    event_id: String(eventId).slice(0, 64), event_type: String(type), schema_version: ev.schema_version ?? 1, source: "johnvivz_inventory",
    occurred_at: pick(ev, "occurred_at", "created_at") ?? null, entity_id: pick(ev, "entity_id", "aggregate_id") ?? null,
    correlation_id: pick(ev, "correlation_id") ?? null, idempotency_key: pick(ev, "idempotency_key") ?? null, data,
  };
}

/** The list inside Inventory's outbox answer: {items}, {events}, {data}, {outbox} or a bare array. */
export function outboxItems(body) {
  if (Array.isArray(body)) return body;
  for (const k of ["items", "events", "data", "outbox"]) if (Array.isArray(body?.[k])) return body[k];
  return [];
}
