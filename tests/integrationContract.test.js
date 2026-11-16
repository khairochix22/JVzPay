// CRM integration contract v0.4.1: signed requests (§2) and the CRM sale events (§3, §4) with VAT computed by Accounting.
// Pure unit tests (no database). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { computeSignature, signedHeaders, verifySignedRequest, ReplayGuard, manilaTimestamp } from "../lib/serviceSignature.js";
import { saleFromContract, cancelFromContract, refundFromContract, refundVat, inclusiveVat, manilaDate, isContractShape, SaleMappingError } from "../services/crmSaleMapping.js";

const SECRET = "test-secret-not-real";
const secretFor = (c) => (c === "johnvivz_crm" ? SECRET : "");

test("signature: exactly HMAC_SHA256(secret, METHOD\\npath\\ntimestamp\\nsha256hex(body))", () => {
  const body = '{"a":1}';
  const ts = "2026-11-13T09:30:00.000+08:00";
  const manual = crypto.createHmac("sha256", SECRET)
    .update(`POST\n/api/integration/v1/events?x=1\n${ts}\n${crypto.createHash("sha256").update(body).digest("hex")}`).digest("hex");
  assert.equal(computeSignature(SECRET, "post", "/api/integration/v1/events?x=1", ts, body), manual);
  // no body: sha256 of the empty string
  const empty = crypto.createHmac("sha256", SECRET).update(`GET\n/h\n${ts}\n${crypto.createHash("sha256").update("").digest("hex")}`).digest("hex");
  assert.equal(computeSignature(SECRET, "GET", "/h", ts), empty);
});

test("signature: timestamps are Philippine time with +08:00", () => {
  assert.equal(manilaTimestamp(new Date("2026-11-13T01:30:00.000Z")), "2026-11-13T09:30:00.000+08:00");
  const h = signedHeaders(SECRET, "GET", "/api/v1/health", "", new Date("2026-11-13T01:30:00.000Z"));
  assert.equal(h["X-JVZ-Client"], "johnvivz_accounting");
  assert.equal(h["X-JVZ-Timestamp"], "2026-11-13T09:30:00.000+08:00");
});

test("signature: valid, stale, tampered, replayed, unknown sender", () => {
  const now = Date.parse("2026-11-13T09:30:00.000+08:00");
  const ts = "2026-11-13T09:29:00.000+08:00";
  const path = "/api/integration/v1/reconciliation/sales?from=2026-11-01";
  const sig = computeSignature(SECRET, "GET", path, ts, "");
  const base = { client: "johnvivz_crm", timestamp: ts, signature: sig, method: "GET", path, body: "", secretFor, nowMs: now };
  const guard = new ReplayGuard();
  assert.equal(verifySignedRequest({ ...base, guard }), null);
  assert.equal(verifySignedRequest({ ...base, guard }), "replayed_request");
  assert.equal(verifySignedRequest({ ...base, path: "/api/integration/v1/reconciliation/sales?from=2026-10-01" }), "invalid_signature", "the query string is signed");
  assert.equal(verifySignedRequest({ ...base, body: "{}" }), "invalid_signature");
  assert.equal(verifySignedRequest({ ...base, nowMs: now + 6 * 60 * 1000 }), "stale_timestamp");
  assert.equal(verifySignedRequest({ ...base, nowMs: now - 4 * 60 * 1000 }), null, "exactly 5 minutes away is still inside the window");
  assert.equal(verifySignedRequest({ ...base, nowMs: now - 7 * 60 * 1000 }), "stale_timestamp");
  assert.equal(verifySignedRequest({ ...base, client: "johnvivz_inventory" }), "unauthorized", "a secret is valid only for its own app");
  assert.equal(verifySignedRequest({ ...base, signature: "" }), "unauthorized");
  // Z or any other offset is accepted
  const z = "2026-11-13T01:29:00.000Z";
  assert.equal(verifySignedRequest({ ...base, timestamp: z, signature: computeSignature(SECRET, "GET", path, z, "") }), null);
});

const sale = (over = {}) => ({
  sale_id: "8f0e8a54-2c3b-4d1e-9a5b-1c2d3e4f5a6b", order_id: "ord-1", transaction_no: "TXN-0001", customer_id: "cus-9",
  completed_at: "2026-11-13T09:30:00.000+08:00", payment_status: "paid", currency: "PHP",
  items: [
    { line_no: 1, product_id: "p1", sku: "RICE1", quantity: 2, unit_price: "56.00", discount_amount: "0.00", line_total: "112.00", is_vatable: true },
    { line_no: 2, product_id: "p2", sku: "PORK", quantity: 1.5, unit_price: "120.00", discount_amount: "10.00", line_total: "170.00", is_vatable: false },
  ],
  discounts: [], totals: { gross: "292.00", discount_total: "10.00", net: "282.00" },
  payments: [{ method: "cash", reference_no: null, amount: "282.00", paid_at: "2026-11-13T09:29:00.000+08:00" }],
  ...over,
});

test("SaleCompleted (contract): mapped, VAT = vatable lines × 12/112, entry balances", () => {
  assert.ok(isContractShape(sale()) && !isContractShape({ transaction_id: "S-1", lines: [] }));
  const s = saleFromContract(sale());
  assert.equal(s.transaction_id, "8f0e8a54-2c3b-4d1e-9a5b-1c2d3e4f5a6b");
  assert.equal(s.transaction_date, "2026-11-13");
  assert.equal(s.payment_status, "paid");
  assert.equal(s.payment_method, "cash");
  assert.equal(s.customer_ref, "cus-9");
  assert.deepEqual([s.gross, s.discount, s.total, s.tax], [29200, 1000, 28200, 1200]);
  // Dr cash + discounts = Cr revenue (net of VAT) + Output VAT
  assert.equal(s.total + s.discount, (s.gross - s.tax) + s.tax);
});

test("SaleCompleted (contract): order-level discount spread over the lines before VAT", () => {
  const s = saleFromContract(sale({ discounts: [{ code: "PROMO", type: "fixed", amount: "10.00" }], totals: { gross: "292.00", discount_total: "20.00", net: "272.00" }, payments: [{ method: "gcash", reference_no: "GC1", amount: "272.00" }] }));
  assert.equal(s.tax, 1157); // 112 × 272/282 × 12/112
  assert.equal(inclusiveVat([{ lineNet: 11200, isVatable: false }], 11200), 0);
});

test("SaleCompleted (contract): refuses what does not add up, with a reason", () => {
  const bad = (over, re) => assert.throws(() => saleFromContract(sale(over)), (e) => e instanceof SaleMappingError && re.test(e.message));
  bad({ sale_id: null }, /sale_id is required/);
  bad({ completed_at: "yesterday" }, /completed_at/);
  bad({ totals: { gross: "300.00", discount_total: "10.00", net: "290.00" } }, /totals.gross/);
  bad({ totals: { gross: "292.00", discount_total: "10.00", net: "280.00" } }, /totals.net/);
  bad({ items: [{ ...sale().items[0], is_vatable: undefined }] }, /is_vatable/);
  // CRM sends only "paid" (payment verified before completion): on_account and part-paid are refused
  bad({ payment_status: "on_account", payments: [] }, /must be "paid"/);
  bad({ payment_status: "pending", payments: [] }, /must be "paid"/);
  bad({ payments: [{ method: "cash", amount: "100.00" }] }, /do not cover totals.net/);
  bad({ currency: "USD" }, /PHP/);
  assert.equal(saleFromContract(sale({ payments: [] })).payment_status, "paid", "paid without a payments list is accepted");
});

test("SaleCancelled / RefundRecorded (contract)", () => {
  assert.deepEqual(cancelFromContract({ order_id: "ord-1", sale_id: null, reason: "Customer left", cancelled_at: "2026-11-13T10:00:00+08:00", release_items: [] }),
    { transaction_id: null, order_id: "ord-1", reason: "Customer left", date: "2026-11-13" });
  const r = refundFromContract({ refund_id: "rf-1", sale_id: "s-1", order_id: "o", amount: "56.00", reason: "Spoiled", return_items: [], approved_by_employee_id: null, recorded_at: "2026-11-13T23:30:00Z" });
  assert.deepEqual(r, { transaction_id: "s-1", refund_id: "rf-1", amount: 5600, date: "2026-11-14", reason: "Spoiled" });
  assert.equal(refundVat(5600, 1200, 28200), 238);
  assert.equal(refundVat(5000, 0, 29000), 0);
  assert.equal(manilaDate("2026-11-13T16:00:00Z"), "2026-11-14");
});
