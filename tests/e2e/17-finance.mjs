// Finance modules: accounts payable with approval and three-way matching, CRM sales (paid, on account, cancelled,
// refunded), accounts receivable and collections, bank reconciliation and budgets. Every posting is checked in the ledger.
import { Client, check, report, db, errText } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;

const admin = new Client(base), carla = new Client(base), paolo = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
await carla.login("carla@johnvivz.local", "Welcome2026ok");
await carla.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
await paolo.login("paolo@johnvivz.local", "Rotated2026ok");
await paolo.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
const acct = async (code) => (await selectOne("SELECT id FROM chart_of_accounts WHERE code = ?", [code])).id;
const lines = async (entryId) => Object.fromEntries((await select("SELECT a.code, l.debit, l.credit FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.entry_id = ?", [entryId])).map((l) => [l.code, Number(l.debit) || -Number(l.credit)]));
const balance = async (code) => Number((await selectOne(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id AND j.status IN ('posted','reversed') JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.code = ?`, [code])).b);

// ---- access
check("payroll staff cannot open payables (403)", (await paolo.get("/accounting/payables")).status === 403);
let r = await carla.get("/accounting/payables");
check("accounting staff open payables", r.status === 200 && r.text.includes("Record a supplier invoice"));

// ---- accounts payable: record → approve → pay → balance
r = await carla.submit("/accounting/payables", "/accounting/payables/suppliers", { name: "Mindoro Utilities Co.", payment_terms_days: "15" });
const sup = await selectOne("SELECT id FROM suppliers WHERE name = 'Mindoro Utilities Co.'");
check("supplier added", r.status === 302 && !!sup, `${r.status} ${r.loc || ""} ${errText(r)}`);
if (!sup) { report(); await sequelize.close(); process.exit(0); }
r = await carla.multipart("/accounting/payables/invoices", { _csrf: await carla.csrf("/accounting/payables"), supplier_id: sup.id, invoice_no: "MU-5501", invoice_date: "2026-11-03", amount: "8400.00", debit_account_id: await acct("5120"), description: "Electricity, October" });
const inv = await selectOne("SELECT * FROM supplier_invoices WHERE invoice_no = 'MU-5501'");
check("invoice recorded and waiting, not yet posted", r.status === 302 && inv.status === "pending_approval" && !inv.journal_entry_id && String(inv.due_date).length > 0, errText(r));
r = await carla.post(`/accounting/payables/invoices/${inv.id}/decision`, { _csrf: await carla.csrf("/accounting/payables"), action: "approve" });
check("accounting staff cannot approve (403)", r.status === 403);
r = await admin.submit("/accounting/payables", `/accounting/payables/invoices/${inv.id}/decision`, { action: "approve" });
const approved = await selectOne("SELECT * FROM supplier_invoices WHERE id = ?", [inv.id]);
const je1 = await lines(approved.journal_entry_id);
check("approval posts Dr Utilities / Cr Accounts Payable", approved.status === "unpaid" && je1["5120"] === 8400 && je1["2010"] === -8400, JSON.stringify(je1));
r = await carla.submit("/accounting/payables", `/accounting/payables/invoices/${inv.id}/payments`, { amount: "9000", payment_date: "2026-11-10", cash_account_id: await acct("1020"), method: "bank_transfer" });
check("a payment above the balance is refused", (await selectOne("SELECT amount_paid FROM supplier_invoices WHERE id = ?", [inv.id])).amount_paid === "0.00");
await carla.submit("/accounting/payables", `/accounting/payables/invoices/${inv.id}/payments`, { amount: "3400", payment_date: "2026-11-10", cash_account_id: await acct("1020"), method: "bank_transfer", reference_no: "BT-1" });
check("a partial payment leaves it partially paid", (await selectOne("SELECT status, amount_paid FROM supplier_invoices WHERE id = ?", [inv.id])).status === "partially_paid");
await carla.submit("/accounting/payables", `/accounting/payables/invoices/${inv.id}/payments`, { amount: "5000", payment_date: "2026-11-12", cash_account_id: await acct("1020"), method: "bank_transfer", reference_no: "BT-2" });
const pays = await select("SELECT journal_entry_id FROM supplier_payments WHERE supplier_invoice_id = ?", [inv.id]);
const je2 = await lines(pays[1].journal_entry_id);
check("the last payment closes it: Dr AP / Cr Cash in Bank", (await selectOne("SELECT status FROM supplier_invoices WHERE id = ?", [inv.id])).status === "paid" && je2["2010"] === 5000 && je2["1020"] === -5000);

// ---- Inventory → three-way match
await admin.submit("/settings/integration", "/settings/integration/tokens", { source: "johnvivz_inventory", name: "Inventory for finance test" });
const invToken = /(jvz_[A-Za-z0-9_-]{20,})/.exec((await admin.get("/settings/integration")).text)?.[1];
await admin.submit("/settings/integration", "/settings/integration/tokens", { source: "johnvivz_crm", name: "CRM for finance test" });
const crmToken = /(jvz_[A-Za-z0-9_-]{20,})/.exec((await admin.get("/settings/integration")).text)?.[1];
let seq = 0;
const send = (token, source, event_type, data) => fetch(`${base}/api/v1/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ event_id: `fin-${Date.now()}-${++seq}`, event_type, source, data }) }).then(async (x) => ({ status: x.status, body: await x.json() }));
r = await send(invToken, "johnvivz_inventory", "PurchaseOrderApproved", { purchase_order_id: "PO-77", supplier_ref: "SUP-9", supplier_name: "Calapan Grocers Supply", order_date: "2026-11-04", lines: [{ product_ref: "RICE-25", quantity: 20, unit_cost: "1250.00" }], total_amount: "25000.00" });
check("purchase order received", r.status === 202, JSON.stringify(r.body));
r = await send(invToken, "johnvivz_inventory", "SupplierInvoiceReceived", { supplier_invoice_no: "CGS-100", purchase_order_id: "PO-77", invoice_date: "2026-11-06", amount: "25000.00" });
const unmatched = await selectOne("SELECT * FROM supplier_invoices WHERE invoice_no = 'CGS-100'");
check("an invoice before the goods arrive is unmatched", r.status === 202 && unmatched.match_status === "unmatched" && unmatched.source === "inventory");
r = await admin.submit("/accounting/payables", `/accounting/payables/invoices/${unmatched.id}/decision`, { action: "approve" });
check("an unmatched invoice cannot be approved", r.status === 400 && (await selectOne("SELECT status FROM supplier_invoices WHERE id = ?", [unmatched.id])).status === "pending_approval");
await admin.submit("/accounting/payables", `/accounting/payables/invoices/${unmatched.id}/decision`, { action: "reject", remarks: "Goods not received yet" });
await send(invToken, "johnvivz_inventory", "GoodsReceived", { goods_receipt_id: "GR-77", purchase_order_id: "PO-77", received_date: "2026-11-07", lines: [{ product_ref: "RICE-25", quantity: 20, unit_cost: "1250.00" }], total_amount: "25000.00" });
r = await send(invToken, "johnvivz_inventory", "SupplierInvoiceReceived", { supplier_invoice_no: "CGS-101", purchase_order_id: "PO-77", goods_receipt_id: "GR-77", invoice_date: "2026-11-08", amount: "25000.00" });
const matched = await selectOne("SELECT * FROM supplier_invoices WHERE invoice_no = 'CGS-101'");
check("after the goods receipt the invoice is three-way matched", matched?.match_status === "matched", JSON.stringify(r.body));
await admin.submit("/accounting/payables", `/accounting/payables/invoices/${matched.id}/decision`, { action: "approve" });
const je3 = await lines((await selectOne("SELECT journal_entry_id FROM supplier_invoices WHERE id = ?", [matched.id])).journal_entry_id);
check("approval posts Dr Merchandise Inventory / Cr AP", je3["1200"] === 25000 && je3["2010"] === -25000);
r = await send(invToken, "johnvivz_inventory", "StockAdjusted", { adjustment_id: "ADJ-1", date: "2026-11-09", amount: "-1250.00", reason: "Damaged sack" });
check("a stock loss posts Dr Inventory Adjustments / Cr Inventory", r.status === 202 && (await balance("5050")) === 1250);

// ---- CRM sales
r = await send(crmToken, "johnvivz_crm", "SaleCompleted", { transaction_id: "S-1", order_id: "O-1", transaction_date: "2026-11-09", payment_status: "paid", payment_method: "cash",
  lines: [{ product_ref: "RICE-25", quantity: 2, unit_price: "1500.00", discount: "100.00", tax: "0" }], total_amount: "2900.00" });
const s1 = await selectOne("SELECT * FROM sales_imports WHERE transaction_id = 'S-1'");
const je4 = await lines(s1.journal_entry_id);
check("a paid sale posts Dr Cash, Dr Discounts / Cr Sales", r.status === 202 && je4["1010"] === 2900 && je4["4030"] === 100 && je4["4010"] === -3000, JSON.stringify(je4));
r = await send(crmToken, "johnvivz_crm", "SaleCompleted", { transaction_id: "S-2", transaction_date: "2026-11-09", payment_status: "paid", lines: [{ product_ref: "X", quantity: 1, unit_price: "100" }], total_amount: "999" });
check("a sale whose total does not add up is refused", r.status === 422 && /does not equal/.test(r.body.error));
r = await send(crmToken, "johnvivz_crm", "SaleCompleted", { transaction_id: "S-3", transaction_date: "2026-11-10", payment_status: "on_account", customer_ref: "C-55", customer_name: "Barangay Poblacion Store",
  lines: [{ product_ref: "OIL", quantity: 10, unit_price: "450.00" }], total_amount: "4500.00" });
const ar = await selectOne("SELECT * FROM accounts_receivable WHERE crm_transaction_id = 'S-3'");
check("a sale on account becomes a receivable for the CRM customer", r.status === 202 && ar?.source === "crm" && ar.amount === "4500.00" && !!(await selectOne("SELECT id FROM customers WHERE crm_ref = 'C-55'")));
r = await send(crmToken, "johnvivz_crm", "RefundRecorded", { transaction_id: "S-1", amount: "500.00", date: "2026-11-11", reason: "Spoiled item" });
check("a refund posts Dr Sales Returns / Cr Cash", r.status === 202 && (await selectOne("SELECT status, refunded_amount FROM sales_imports WHERE transaction_id = 'S-1'")).status === "partially_refunded");
r = await send(crmToken, "johnvivz_crm", "SaleCompleted", { transaction_id: "S-4", transaction_date: "2026-11-11", payment_status: "paid", lines: [{ product_ref: "EGG", quantity: 3, unit_price: "250" }], total_amount: "750" });
r = await send(crmToken, "johnvivz_crm", "SaleCancelled", { transaction_id: "S-4", reason: "Customer changed mind" });
const s4 = await selectOne("SELECT s.status, j.status AS je FROM sales_imports s JOIN journal_entries j ON j.id = s.journal_entry_id WHERE s.transaction_id = 'S-4'");
check("a cancelled sale is reversed, not deleted", r.status === 202 && s4.status === "cancelled" && s4.je === "reversed");
r = await carla.get("/accounting/sales");
check("CRM Sales page lists them", r.status === 200 && r.text.includes("S-1") && r.text.includes("S-3"));

// ---- receivable collection
r = await carla.submit("/accounting/receivables", `/accounting/receivables/${ar.id}/collections`, { amount: "4500", payment_date: "2026-11-12", cash_account_id: await acct("1010"), method: "cash" });
check("collecting the CRM receivable closes it", r.status === 302 && (await selectOne("SELECT status FROM accounts_receivable WHERE id = ?", [ar.id])).status === "paid");
r = await carla.get("/accounting/receivables");
check("receivables page shows aging", r.status === 200 && r.text.includes("1–30 days past due"));

// ---- bank reconciliation
r = await carla.submit("/accounting/banks", "/accounting/banks", { bank_name: "Landbank", account_name: "JohnVivz Grocery Store", account_number: "0012-3456-78", gl_account_id: await acct("1020") });
const bank = await selectOne("SELECT * FROM company_bank_accounts WHERE gl_account_id = ?", [await acct("1020")]);
check("company bank account added, number encrypted", r.status === 302 && bank.account_last4 === "5678" && !bank.account_no_enc.includes("00123456"));
const bookBank = await balance("1020");
r = await carla.submit("/accounting/banks", `/accounting/banks/${bank.id}/reconciliations`, { statement_date: "2026-11-30", statement_balance: String(bookBank) });
const rec = await selectOne("SELECT * FROM bank_reconciliations WHERE bank_account_id = ?", [bank.id]);
check("a reconciliation starts", r.status === 302 && rec?.status === "open");
r = await carla.submit(`/accounting/reconciliations/${rec.id}`, `/accounting/reconciliations/${rec.id}`, { finish: "1" });
check("it cannot close while nothing is ticked", (await selectOne("SELECT status FROM bank_reconciliations WHERE id = ?", [rec.id])).status === "open");
const bankLines = await select("SELECT l.id FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id AND j.status IN ('posted','reversed') WHERE l.account_id = ? AND j.entry_date <= '2026-11-30'", [bank.gl_account_id]);
r = await carla.post(`/accounting/reconciliations/${rec.id}`, { _csrf: await carla.csrf(`/accounting/reconciliations/${rec.id}`), finish: "1", lines: bankLines.map((l) => String(l.id)) });
check("ticking every line balances and closes it", (await selectOne("SELECT status FROM bank_reconciliations WHERE id = ?", [rec.id])).status === "reconciled", `book ${bookBank}, lines ${bankLines.length}`);

// ---- budgets
check("accounting staff can view budgets but not set them", (await carla.get("/accounting/budgets")).status === 200 && (await carla.submit("/accounting/budgets", "/accounting/budgets", { year: "2026", account_id: await acct("5120") })).status === 403);
r = await admin.submit("/accounting/budgets", "/accounting/budgets", { year: "2026", account_id: String(await acct("5120")), month_11: "8000" });
r = await admin.get("/accounting/budgets?year=2026");
check("budget vs actual shows the utilities overspend", r.status === 200 && r.text.includes("Utilities Expense") && r.text.includes("105%"), errText(r));

report();
await sequelize.close();
process.exit(0);
