// HR pull sync, ESS registration check and Inventory outbox mapping (team decisions 2026-11-16).
// Pure unit tests (no database). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapEmployee, mapDepartment, mapCompensation, employmentStatus, listOf, totalPagesOf, recordOf, separationDate, mismatchLabels, supervisorMap, isEmployeeRecord, HrMappingError } from "../services/hrMapping.js";
import { mapPurchaseOrder, mapGoodsReceipt, envelopeFromOutbox, outboxItems, NO_POSTING, NOT_SENT_BY_INVENTORY, InventoryMappingError } from "../services/inventoryMapping.js";
import { eventsEnabled } from "../services/integrationService.js";

// shapes of HR's LIVE API (read 2026-11-17); personal values below are made up
const hrEmployee = (over = {}) => ({
  employee_id: 104, permanent_employee_id: "JV-2026-00004", employee_code: "BAUTISTA11172026", first_name: "Kristine", last_name: "Bautista",
  full_name: "Kristine Bautista", email: "new.hire@example.com", phone_number: "09170000000",
  department: { department_id: 4, department_code: "CRM", department_name: "CRM System" }, position: "Agent", employment_type: null,
  work_schedule: null, reporting_supervisor_id: 103, hire_date: "2026-11-17", status: "Active", ...over,
});

test("HR employee (live API shape) → EmployeeCreated data", () => {
  const d = mapEmployee(hrEmployee(), supervisorMap([{ employee_id: 103, permanent_employee_id: "JV-2025-00003" }]));
  assert.equal(d.employee_id, "JV-2026-00004", "JVzPay keys employees by the JV Employee ID (permanent_employee_id)");
  assert.equal(d.employee_no, "JV-2026-00004");
  assert.equal(d.department_code, "CRM");
  assert.equal(d.department_name, "CRM System");
  assert.equal(d.position_title, "Agent");
  assert.equal(d.employment_status, "active");
  assert.equal(d.date_hired, "2026-11-17");
  assert.equal(d.verification_reference, "BAUTISTA11172026");
  assert.equal(d.employee_code, "BAUTISTA11172026");
  assert.equal(d.phone, "09170000000");
  assert.equal(d.supervisor_employee_id, "JV-2025-00003", "reporting_supervisor_id (HR's internal number) becomes the supervisor's JV number");
  assert.ok(!("employment_type" in d), "an unknown or empty employment_type is left out");
  assert.ok(!("supervisor_employee_id" in mapEmployee(hrEmployee())), "without HR's list the supervisor is left unchanged");
  assert.equal(mapEmployee(hrEmployee({ reporting_supervisor_id: null }), new Map()).supervisor_employee_id, null);
});

test("HR employee: system accounts are not employees; missing data is refused with HR's field names", () => {
  const system = { employee_id: 1, permanent_employee_id: null, position: "System account", status: "Active" };
  assert.equal(isEmployeeRecord(system), false);
  assert.equal(isEmployeeRecord(hrEmployee()), true);
  assert.throws(() => mapEmployee(system), /no permanent_employee_id/);
  assert.throws(() => mapEmployee(hrEmployee({ position: null, hire_date: null })), (e) => e instanceof HrMappingError && /HR did not send position, hire_date/.test(e.message));
});

test("HR employment status words (Active, On Leave, Suspended, Resigned, Terminated)", () => {
  assert.equal(employmentStatus("Active"), "active");
  assert.equal(employmentStatus("On Leave"), "on_leave");
  assert.equal(employmentStatus("Suspended"), "suspended");
  assert.equal(employmentStatus("Resigned"), "resigned");
  assert.equal(employmentStatus("TERMINATED"), "terminated");
  assert.throws(() => employmentStatus("separated"), /unknown employment status/, "words HR does not use are reported, not guessed");
});

test("HR departments, paging and detail answers (live shapes)", () => {
  assert.deepEqual(mapDepartment({ department_id: 2, department_code: "ACCOUNTING", department_name: "Accounting/Payroll", description: "x", active_headcount: 0 }), { department_code: "ACCOUNTING", department_name: "Accounting/Payroll", is_active: true });
  assert.throws(() => mapDepartment({ department_id: 9 }), /department_code/);
  const list = { success: true, data: { items: [1, 2], page: 1, page_size: 50, total: 3, total_pages: 2 }, message: "", errors: {} };
  assert.deepEqual(listOf(list), [1, 2]);
  assert.equal(totalPagesOf(list), 2);
  assert.deepEqual(listOf({ success: true, data: [7] }), [7], "departments come as data: [...]");
  assert.equal(totalPagesOf({ success: true, data: [7] }), 1);
  assert.deepEqual(recordOf({ success: true, data: { employee_id: 1 } }), { employee_id: 1 });
  assert.equal(recordOf(null), null);
  assert.equal(separationDate({}, "2026-11-17"), "2026-11-17", "HR sends no separation date: the day the sync sees it");
});

test("HR approved compensation (data.compensation) → EmployeeCompensationApproved data", () => {
  assert.deepEqual(mapCompensation({ as_of: "2026-11-17", compensation_version_id: 4, basic_salary: 16500, compensation_basis: "monthly", components: [], fixed_monthly_total: 16500 }, "JV-2026-00004"), {
    employee_id: "JV-2026-00004", basic_salary: 16500, rate_basis: "monthly", effective_date: "2026-11-17", compensation_version_id: "4",
  });
  assert.equal(mapCompensation({ as_of: "2026-11-17", compensation_version_id: null, basic_salary: 560, compensation_basis: "daily", components: [] }, "JV-1").rate_basis, "daily");
  assert.equal(mapCompensation(null, "JV-1"), null, "no compensation object: nothing to record");
  assert.equal(mapCompensation({ as_of: "2026-11-17", basic_salary: null }, "JV-1"), null);
  assert.throws(() => mapCompensation({ basic_salary: 1, compensation_basis: "monthly" }, "JV-1"), /as_of/);
  assert.throws(() => mapCompensation({ basic_salary: 1, as_of: "2026-11-17", compensation_basis: "hourly" }, "JV-1"), /hourly/);
});

test("registration check: HR's mismatches become form labels, never values", () => {
  assert.deepEqual(mismatchLabels(["email"]), ["Email"], "HR's live answer: mismatches: [\"email\"]");
  assert.deepEqual(mismatchLabels(["full_name", "department", "position", "employee_code", "verification_reference"]), ["Full name", "Department", "Position", "Unique code"]);
  assert.deepEqual(mismatchLabels([{ field: "email", hr_value: "hr@example.com" }]), ["Email"]);
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


// the org settings tests use the documented defaults, whatever the developer's .env says
const withDefaultOrgSettings = async (fn) => {
  const keys = ["ACCOUNTING_DEPARTMENT_CODE", "POSITION_ROLES", "DEPARTMENT_SUPERVISOR_TITLES"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try { await fn(); } finally { for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
};

test("position → JVzPay role (POSITION_ROLES): only Payroll/Accounting titles get a working role", () => withDefaultOrgSettings(async () => {
  const { roleForPosition, parsePositionRoles } = await import("../lib/orgSettings.js");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "Accounting Supervisor"), "accounting_supervisor");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "accounting  staff"), "accounting_staff");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "Payroll Staff"), "payroll_staff");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "Staff"), "employee", "an unmapped title gets Self-Service only");
  assert.equal(roleForPosition("CRM", "Accounting Supervisor"), "employee", "another department's titles are always employee");
  assert.equal(roleForPosition("PAYROLL_ACCOUNTING", "Bookkeeper", parsePositionRoles("Bookkeeper=accounting_staff,Boss=superuser")), "accounting_staff");
  assert.equal(parsePositionRoles("Boss=superuser").size, 0, "unknown roles are ignored");
}));

test("department supervisor titles (DEPARTMENT_SUPERVISOR_TITLES): ranked, per department", () => withDefaultOrgSettings(async () => {
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
}));

test("Inventory poll uses only Inventory's own token", async () => {
  const { tokenProblem } = await import("../services/inventoryPollService.js");
  assert.doesNotThrow(() => tokenProblem({ INVENTORY_API_TOKEN: "inv-token", CRM_INBOUND_SECRET: "crm-secret" }));
  assert.throws(() => tokenProblem({}), /INVENTORY_API_TOKEN is not set/);
  assert.throws(() => tokenProblem({ INVENTORY_API_TOKEN: "same", CRM_INBOUND_SECRET: "same" }), /same as CRM_INBOUND_SECRET/);
  assert.throws(() => tokenProblem({ INVENTORY_API_TOKEN: "same", CRM_API_TOKEN: "same" }), /own token/);
});
