// CRM sale events in the shape of the CRM integration contract v0.4.1 (§3, §4), turned into what JVzPay posts.
// Pure functions (no database), so they are unit-tested on their own.
//
//   SaleCompleted  { sale_id, order_id, transaction_no, customer_id, completed_at, items[{line_no, product_id, sku, quantity,
//                    unit_price, discount_amount, line_total, is_vatable}], discounts[{code, type, amount}],
//                    totals{gross, discount_total, net}, payments[{method, reference_no, amount, paid_at}], payment_status, currency }
//   SaleCancelled  { order_id, sale_id (null before completion), reason, cancelled_at, release_items[...] }
//   RefundRecorded { refund_id, sale_id, order_id, amount, reason, return_items[...], approved_by_employee_id, recorded_at }
//
// VAT (contract §0; CRM confirmed 2026-11-16 that its prices include 12% VAT): CRM sends shelf prices without a VAT split
// and `is_vatable` per line; Accounting computes Output VAT = vatable amount after discounts × 12/112.
// payment_status (CRM confirmed 2026-11-16): always "paid" — CRM completes an order only after the payment is verified.
// An order-level discount (discount_total above the line discounts) is spread over the lines in proportion to their amounts.
export const VAT_RATE = 0.12;

export class SaleMappingError extends Error {}
const fail = (m) => { throw new SaleMappingError(m); };

/** Money (decimal string or number) in centavos. */
export function cents(v, label) {
  if (v === null || v === undefined || v === "") fail(`${label} is required.`);
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${label} must be an amount.`);
  return Math.round(n * 100);
}

/** The Philippine calendar date (YYYY-MM-DD) of an ISO-8601 timestamp with an offset. */
export function manilaDate(iso, label) {
  const t = Date.parse(String(iso || ""));
  if (!iso || Number.isNaN(t)) fail(`${label} must be an ISO-8601 date and time.`);
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const ref = (v, max = 80) => (v === null || v === undefined || v === "" ? null : String(v).trim().slice(0, max) || null);

/** An event in the contract's shape (as opposed to JVzPay's older transaction_id/lines/total_amount shape). */
export const isContractShape = (d) => !!d && ("sale_id" in d || "items" in d || "totals" in d || "refund_id" in d || "cancelled_at" in d);

/** Output VAT included in the vatable lines, after line and order-level discounts. All amounts in centavos. */
export function inclusiveVat(lines, net) {
  const sumLineNet = lines.reduce((s, l) => s + l.lineNet, 0);
  if (sumLineNet <= 0) return 0;
  const vatableNet = lines.filter((l) => l.isVatable).reduce((s, l) => s + l.lineNet, 0) * (net / sumLineNet);
  return Math.round((vatableNet * VAT_RATE) / (1 + VAT_RATE));
}

/** SaleCompleted (contract shape) → the values JVzPay posts. Throws SaleMappingError with a readable reason. */
export function saleFromContract(d) {
  const saleId = ref(d.sale_id);
  if (!saleId) fail("data.sale_id is required.");
  const transactionDate = manilaDate(d.completed_at, "data.completed_at");
  if (!Array.isArray(d.items) || !d.items.length) fail("data.items must list at least one item.");
  if (d.currency && String(d.currency).toUpperCase() !== "PHP") fail("data.currency must be PHP.");

  const lines = d.items.map((it, i) => {
    const q = Number(it.quantity);
    if (!(q > 0)) fail(`items[${i}].quantity must be more than 0.`);
    const gross = Math.round(q * cents(it.unit_price, `items[${i}].unit_price`));
    const discount = it.discount_amount ? cents(it.discount_amount, `items[${i}].discount_amount`) : 0;
    if (discount < 0 || discount > gross) fail(`items[${i}].discount_amount must be between 0 and the line amount.`);
    const lineNet = gross - discount;
    if (it.line_total !== undefined && it.line_total !== null && Math.abs(cents(it.line_total, `items[${i}].line_total`) - lineNet) > 1) {
      fail(`items[${i}].line_total does not equal quantity × unit_price − discount_amount.`);
    }
    if (typeof it.is_vatable !== "boolean") fail(`items[${i}].is_vatable must be true or false.`);
    return { gross, discount, lineNet, isVatable: it.is_vatable };
  });

  const t = d.totals || fail("data.totals is required.");
  const gross = cents(t.gross, "totals.gross");
  const discount = t.discount_total ? cents(t.discount_total, "totals.discount_total") : 0;
  const net = cents(t.net, "totals.net");
  const lineGross = lines.reduce((s, l) => s + l.gross, 0), lineDiscount = lines.reduce((s, l) => s + l.discount, 0);
  if (Math.abs(lineGross - gross) > 1) fail(`totals.gross does not equal the items (${(lineGross / 100).toFixed(2)}).`);
  if (discount < lineDiscount - 1) fail("totals.discount_total is less than the item discounts.");
  if (Math.abs(gross - discount - net) > 1) fail("totals.net must equal totals.gross − totals.discount_total.");
  if (net <= 0) fail("totals.net must be more than 0.");

  const payments = Array.isArray(d.payments) ? d.payments : [];
  const paid = payments.reduce((s, p, i) => s + cents(p.amount, `payments[${i}].amount`), 0);
  // CRM's answer (2026-11-16): CRM completes an order only after the payment is verified, so it sends only "paid"
  // (no on_account, no part-paid). Anything else is refused with the reason instead of being guessed.
  if (String(d.payment_status || "").toLowerCase() !== "paid") fail('data.payment_status must be "paid": CRM completes a sale only after the payment is verified.');
  if (payments.length && paid < net) fail("payments do not cover totals.net for a paid sale.");
  const paymentStatus = "paid";
  const methods = [...new Set(payments.map((p) => ref(p.method, 40)).filter(Boolean))];

  return {
    transaction_id: saleId,
    transaction_no: ref(d.transaction_no),
    order_id: ref(d.order_id),
    customer_ref: ref(d.customer_id),
    customer_name: ref(d.customer_name, 160),
    transaction_date: transactionDate,
    payment_status: paymentStatus,
    payment_method: methods.length ? methods.join(" + ") : null,
    gross, discount, tax: inclusiveVat(lines, net), total: net,
    vatInclusive: true,
    line_items: d.items,
  };
}

/** SaleCancelled (contract shape). `transaction_id` is null when the order was cancelled before it became a sale. */
export function cancelFromContract(d) {
  return {
    transaction_id: ref(d.sale_id),
    order_id: ref(d.order_id),
    reason: ref(d.reason, 120),
    date: d.cancelled_at ? manilaDate(d.cancelled_at, "data.cancelled_at") : null,
  };
}

/** RefundRecorded (contract shape) → { transaction_id, amount (centavos), date, reason, refund_id }. */
export function refundFromContract(d) {
  const saleId = ref(d.sale_id);
  if (!saleId) fail("data.sale_id is required.");
  return {
    transaction_id: saleId,
    refund_id: ref(d.refund_id),
    amount: cents(d.amount, "data.amount"),
    date: manilaDate(d.recorded_at, "data.recorded_at"),
    reason: ref(d.reason, 120),
  };
}

/** The Output VAT part of a refund, in proportion to the VAT posted with the sale. */
export const refundVat = (refund, saleTax, saleTotal) => (saleTotal > 0 && saleTax > 0 ? Math.round((refund * saleTax) / saleTotal) : 0);
