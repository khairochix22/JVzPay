// HR pull sync, ESS registration check and Inventory outbox mapping (team decisions 2026-11-16).
// Pure unit tests (no database). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapEmployee, mapDepartment, mapCompensation, employmentStatus, listOf, totalPagesOf, recordOf, separationDate, mismatchLabels, HrMappingError } from "../services/hrMapping.js";
import { mapPurchaseOrder, mapGoodsReceipt, envelopeFromOutbox, outboxItems, NO_POSTING, NOT_SENT_BY_INVENTORY, InventoryMappingError } from "../services/inventoryMapping.js";
import { eventsEnabled } from "../services/integrationService.js";

const hrEmployee = (over = {}) => ({
  id: 77, employee_id: "JV-2026-00012", first_name: "Andrea", middle_name: "Lopez", last_name: "Bautista", email: "new.hire@example.com",
  department_id: 3, position: { id: 9, title: "Agent" }, employment_status: "Active", hire_date: "2026-11-02T00:00:00+08:00",
  employee_code: "QX-5521-AB", supervisor_employee_id: "JV-2025-00004", ...over,
});
const depts = new Map([["3", { code: "CRM", name: "Customer Relations" }]]);

test("HR employee → EmployeeCreated data (JV number, department by id, nested position, unique code)", () => {
  const d = mapEmployee(hrEmployee(), depts);
  assert.equal(d.employee_id, "JV-2026-00012");
  assert.equal(d.employee_no, "JV-2026-00012");
  assert.equal(d.department_code, "CRM");
  assert.equal(d.department_name, "Customer Relations");
  assert.equal(d.position_title, "Agent");
  assert.equal(d.employment_status, "active");
  assert.equal(d.date_hired, "2026-11-02");
  assert.equal(d.verification_reference, "QX-5521-AB");
  assert.equal(d.employee_code, "QX-5521-AB");
  assert.equal(d.supervisor_employee_id, "JV-2025-00004");
  assert.ok(!("phone" in d), "fields HR does not send are left out, not sent as empty");
});

test("HR employee: full_name is split, codes given directly, missing data is refused with the field names", () => {
  const d = mapEmployee({ employee_id: "JV-2026-00013", full_name: "Rico de la Cruz Navarro", department_code: "PAYROLL_ACCOUNTING", position_title: "Payroll Staff", date_hired: "2026-11-02" });
  assert.equal(d.first_name, "Rico de la Cruz");
  assert.equal(d.last_name, "Navarro");
  assert.throws(() => mapEmployee({ employee_id: "JV-1", first_name: "A", last_name: "B" }), (e) => e instanceof HrMappingError && /department_code, position_title, date_hired/.test(e.message));
  assert.throws(() => mapEmployee({ first_name: "A" }), /without employee_id/);
});

test("HR employment status words", () => {
  assert.equal(employmentStatus("Resigned"), "resigned");
  assert.equal(employmentStatus("TERMINATED"), "terminated");
  assert.equal(employmentStatus("separated"), "terminated");
  assert.equal(employmentStatus("On Leave"), "on_leave");
  assert.equal(employmentStatus("on-leave"), "on_leave");
  assert.equal(employmentStatus("inactive"), "suspended");
  assert.throws(() => employmentStatus("retired-ish"), /unknown employment status/);
});

test("HR departments, paging and detail answers", () => {
  assert.deepEqual(mapDepartment({ id: 3, code: "CRM", name: "Customer Relations", status: "active" }), { department_code: "CRM", department_name: "Customer Relations", is_active: true });
  assert.equal(mapDepartment({ code: "OLD", name: "Old", is_active: false }).is_active, false);
  assert.deepEqual(listOf({ items: [1, 2], page: 1, total_pages: 3 }), [1, 2]);
  assert.deepEqual(listOf({ data: [1] }), [1]);
  assert.deepEqual(listOf([5]), [5]);
  assert.equal(totalPagesOf({ items: [], page: 1, total_pages: 3 }), 3);
  assert.equal(totalPagesOf({ data: [], meta: { last_page: 4 } }), 4);
  assert.equal(totalPagesOf({ items: [] }), 1);
  assert.deepEqual(recordOf({ data: { employee_id: "x" } }), { employee_id: "x" });
  assert.deepEqual(recordOf({ employee_id: "y" }), { employee_id: "y" });
  assert.equal(separationDate({ separation_date: "2026-11-15" }, "2026-11-16"), "2026-11-15");
  assert.equal(separationDate({}, "2026-11-16"), "2026-11-16");
});

test("HR approved compensation → EmployeeCompensationApproved data", () => {
  assert.deepEqual(mapCompensation({ employee_id: "JV-2026-00012", basic_salary: "16500.00", rate_basis: "Monthly", pay_frequency: "semi-monthly", effective_date: "2026-11-01", allowances: [{ code: "RICE", amount: "1500" }], version_id: 4 }), {
    employee_id: "JV-2026-00012", basic_salary: "16500.00", rate_basis: "monthly", effective_date: "2026-11-01", pay_frequency: "semi_monthly", allowances: [{ code: "RICE", amount: "1500" }], compensation_version_id: 4,
  });
  assert.equal(mapCompensation({ employee_id: "JV-1", daily_rate: "560" }), null, "a record without a salary is not compensation");
  assert.throws(() => mapCompensation({ employee_id: "JV-1", basic_salary: "1" }), /effective_date/);
});

test("registration check: HR's mismatches become form labels, never values", () => {
  assert.deepEqual(mismatchLabels(["email", "position", "verification_reference"]), ["Email", "Position", "Unique code"]);
  assert.deepEqual(mismatchLabels([{ field: "full_name", expected: "SECRET VALUE" }, { field: "department" }]), ["Full name", "Department"]);
  assert.deepEqual(mismatchLabels({ email: "hr@example.com" }), ["Email"]);
  assert.deepEqual(mismatchLabels(undefined), []);
  assert.ok(!JSON.stringify(mismatchLabels([{ field: "email", hr_value: "hr@example.com" }])).includes("hr@example.com"));
});

test("events switch: HR is pull-only, so its events are off unless HR_EVENTS_ENABLED says otherwise", () => {
  const saved = { hr: process.env.HR_EVENTS_ENABLED, crm: process.env.CRM_EVENTS_ENABLED };
  try {
    delete process.env.HR_EVENTS_ENABLED; delete process.env.CRM_EVENTS_ENABLED;
    assert.equal(eventsEnabled("hr"), false);
    assert.equal(eventsEnabled("crm"), true);
    assert.equal(eventsEnabled("inventory"), true);
    process.env.HR_EVENTS_ENABLED = "true"; assert.equal(eventsEnabled("hr"), true);
    process.env.CRM_EVENTS_ENABLED = "false"; assert.equal(eventsEnabled("crm"), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) { const n = `${k.toUpperCase()}_EVENTS_ENABLED`; if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  }
});

test("Inventory outbox: envelopes, purchase orders and goods receipts", () => {
  assert.deepEqual(outboxItems({ events: [1] }), [1]);
  assert.deepEqual(outboxItems({ items: [2] }), [2]);
  const env = envelopeFromOutbox({ id: "ev-1", type: "GoodsReceiptRecorded", payload: { grn_number: "GRN-1" }, created_at: "2026-11-16T09:00:00+08:00" });
  assert.equal(env.event_id, "ev-1");
  assert.equal(env.event_type, "GoodsReceiptRecorded");
  assert.equal(env.source, "johnvivz_inventory");
  assert.deepEqual(env.data, { grn_number: "GRN-1" });
  assert.throws(() => envelopeFromOutbox({ event_type: "X" }), (e) => e instanceof InventoryMappingError && /event_id/.test(e.message));
  assert.throws(() => envelopeFromOutbox({ event_id: "1", event_type: "X", source: "johnvivz_crm" }), /comes from johnvivz_crm/);

  const po = mapPurchaseOrder({ po_number: "PO-9", supplier: { id: 4, name: "Calapan Grocers" }, approved_at: "2026-11-04T10:00:00+08:00", items: [{ sku: "RICE-25", qty: 20, cost: "1250.00" }] });
  assert.deepEqual(po, { purchase_order_id: "PO-9", supplier_ref: 4, supplier_name: "Calapan Grocers", order_date: "2026-11-04", lines: [{ product_ref: "RICE-25", quantity: 20, unit_cost: "1250.00" }], total_amount: "25000.00" });
  const gr = mapGoodsReceipt({ grn_number: "GRN-1", po_number: "PO-9", received_at: "2026-11-07", items: [{ product_id: 1, quantity_received: 20, unit_cost: 1250 }], total: "25000.00" });
  assert.equal(gr.goods_receipt_id, "GRN-1");
  assert.equal(gr.purchase_order_id, "PO-9");
  assert.equal(gr.total_amount, "25000.00");
  // JVzPay's own documented shape passes through unchanged
  const own = { purchase_order_id: "PO-77", supplier_ref: "SUP-9", supplier_name: "X", order_date: "2026-11-04", lines: [{ product_ref: "R", quantity: 2, unit_cost: "5.00" }], total_amount: "10.00" };
  assert.deepEqual(mapPurchaseOrder(own), own);
  assert.throws(() => mapGoodsReceipt({ grn_number: "G", received_at: "2026-11-07", items: [{ qty: 1, cost: 1 }] }), /names no purchase order/);
  assert.throws(() => mapPurchaseOrder({ po_number: "P", order_date: "2026-11-01", items: [{ sku: "x" }] }), /quantity and a unit cost/);
});

test("Inventory events without an agreed accounting entry, and JVzPay events Inventory does not send", () => {
  assert.deepEqual(Object.keys(NO_POSTING).sort(), ["InventoryReturnReceived", "PurchaseOrderCancelled", "PurchaseOrderCreated", "PurchaseOrderUpdated", "RefundReported"]);
  assert.deepEqual(NOT_SENT_BY_INVENTORY, ["SupplierInvoiceReceived", "StockAdjusted", "InventoryValuationReported"]);
});

test("position → JVzPay role (POSITION_ROLES): only Payroll/Accounting titles get a working role", async () => {
  const { roleForPosition, parsePositionRoles } = await import("../lib/orgSettings.js");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "Accounting Supervisor"), "accounting_supervisor");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "accounting  staff"), "accounting_staff");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "Payroll Staff"), "payroll_staff");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "Staff"), "employee", "an unmapped title gets Self-Service only");
  assert.equal(roleForPosition("CRM", "Accounting Supervisor"), "employee", "another department's titles are always employee");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "Bookkeeper", parsePositionRoles("Bookkeeper=accounting_staff,Boss=superuser")), "accounting_staff");
  assert.equal(parsePositionRoles("Boss=superuser").size, 0, "unknown roles are ignored");
});

test("department supervisor titles (DEPARTMENT_SUPERVISOR_TITLES): ranked, per department", async () => {
  const { higherSupervisorTitles, isSupervisorTitle, parseSupervisorTitles } = await import("../lib/orgSettings.js");
  assert.deepEqual(higherSupervisorTitles("CRM", "Agent"), ["crm manager", "team leader"]);
  assert.deepEqual(higherSupervisorTitles("CRM", "Team Leader"), ["crm manager"]);
  assert.deepEqual(higherSupervisorTitles("CRM", "CRM Manager"), []);
  assert.deepEqual(higherSupervisorTitles("INVENTORY", "Staff"), ["inventory manager", "inventory supervisor"]);
  assert.deepEqual(higherSupervisorTitles("HR", "HR Supervisor"), ["hr manager"]);
  assert.deepEqual(higherSupervisorTitles("PAYROLL_ACCOUNTING", "Payroll Staff"), ["accounting supervisor"]);
  assert.deepEqual(higherSupervisorTitles("DELI", "Clerk"), [], "a department without supervisor titles");
  assert.ok(isSupervisorTitle("INVENTORY", "Inventory Supervisor") && !isSupervisorTitle("INVENTORY", "Staff") && !isSupervisorTitle("CRM", "HR Manager"));
  assert.deepEqual(parseSupervisorTitles("crm=Boss|Lead").get("CRM"), ["boss", "lead"]);
});

test("Inventory poll uses only Inventory's own token", async () => {
  const { tokenProblem } = await import("../services/inventoryPollService.js");
  assert.doesNotThrow(() => tokenProblem({ INVENTORY_API_TOKEN: "inv-token", CRM_INBOUND_SECRET: "crm-secret" }));
  assert.throws(() => tokenProblem({}), /INVENTORY_API_TOKEN is not set/);
  assert.throws(() => tokenProblem({ INVENTORY_API_TOKEN: "same", CRM_INBOUND_SECRET: "same" }), /same as CRM_INBOUND_SECRET/);
  assert.throws(() => tokenProblem({ INVENTORY_API_TOKEN: "same", CRM_API_TOKEN: "same" }), /own token/);
});
