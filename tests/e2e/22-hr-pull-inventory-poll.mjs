// HR pull sync and Inventory outbox poll (team decisions 2026-11-16), against the fake apps of fakeApps.mjs.
//   HR: pull-only. JVzPay reads departments, employees (paged) and approved compensation through the same handlers as
//       the HR events; a status change goes through EmployeeStatusChanged; Resigned/Terminated removes ESS access.
//   Inventory: no pushes. JVzPay reads its outbox, stores each event once, acknowledges it; Inventory's event names are
//       mapped (GoodsReceiptRecorded → GoodsReceived); events with no agreed accounting entry are recorded only.
import { Client, check, report, db, errText } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;
const ctl = (url, body) => fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const hrCtl = (what, body) => ctl(`${process.env.HR_API_URL}/__test/${what}`, body);
const invCtl = (body) => ctl(`${process.env.INVENTORY_API_URL}/__test/outbox`, body);
const setting = async (key) => { const r = await selectOne("SELECT setting_value FROM system_settings WHERE setting_key = ?", [key]); return r ? JSON.parse(r.setting_value) : null; };

const admin = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
const sync = () => admin.submit("/settings/integration", "/settings/integration/hr-sync", {});
const andreaHr = { employee_id: "JV-2026-00901", first_name: "Andrea", middle_name: "Lopez", last_name: "Bautista", email: "andrea.bautista@gmail.com", department_id: 2, position: { title: "Agent" }, employment_status: "Active", hire_date: "2026-11-02", employee_code: "QX-5521-AB", supervisor_employee_id: "JV-2026-00905" };

// ---- 1. a full sync: paging, a record HR left incomplete, approved compensation listed by HR's payroll endpoint
await hrCtl("employees", { employee_id: "JV-2026-00907", first_name: "Nora", last_name: "Diaz", email: "nora@gmail.com", department_id: 3, employment_status: "Active", hire_date: "2026-11-10", employee_code: "ND-7070" });
await hrCtl("compensation", [
  { employee_id: "JV-2026-00905", basic_salary: "30000.00", rate_basis: "monthly", pay_frequency: "semi_monthly", effective_date: "2026-11-16", version_id: "CV-905-1" },
  { employee_id: "JV-2026-00906", basic_salary: "99000.00", rate_basis: "monthly", effective_date: "2026-11-16" },
]);
// salary bands per position (migration 024 seeds them only where the department already exists; not in a fresh test DB)
for (const [title, min, mid, max] of [["Team Leader", 25000, 32000, 40000], ["Manager", 35000, 45000, 60000]]) {
  const pos = await selectOne("SELECT p.id FROM positions p JOIN departments d ON d.id = p.department_id WHERE d.code = 'CRM' AND p.title = ?", [title]);
  if (pos) await sequelize.query("INSERT IGNORE INTO position_compensation_bands (position_id, effective_from, minimum_monthly, midpoint_monthly, maximum_monthly, enforcement, benchmark_basis) VALUES (?, '2026-11-13', ?, ?, ?, 'block', 'e2e test band')", { replacements: [pos.id, min, mid, max] });
}
let r = await sync();
let s = await setting("integration.hr_sync");
check("Sync now: every page of HR's employee list is read", r.status === 302 && s?.ok === true && s.employees.seen === 9 && s.employees.skipped === 1, JSON.stringify(s)); // 8 employees + HR's system account (no JV number: skipped)
check("an incomplete HR record is skipped and reported; the others are saved", s.employees.failed === 1 && s.problems.some((p) => p.includes("JV-2026-00907") && p.includes("position")) && !(await selectOne("SELECT id FROM employees WHERE hr_employee_id = 'JV-2026-00907'")), JSON.stringify(s.problems));
const liza = await selectOne("SELECT id FROM employees WHERE hr_employee_id = 'JV-2026-00905'");
check("approved compensation from HR's payroll endpoint is recorded (verified, effective-dated)", !!(await selectOne("SELECT id FROM salary_history WHERE employee_id = ? AND new_amount = 30000.00 AND effective_date = '2026-11-16' AND verification_status = 'verified'", [liza.id])));
check("a salary outside the position band is not recorded, and the reason is listed", s.problems.some((p) => p.includes("JV-2026-00906") && /band/.test(p)) && !(await selectOne("SELECT s.id FROM salary_history s JOIN employees e ON e.id = s.employee_id WHERE e.hr_employee_id = 'JV-2026-00906'")), JSON.stringify(s.problems));
const calls = await hrCtl("calls");
check("JVzPay read HR with its API key, page by page", calls.some((c) => c.path.startsWith("/api/integration/v1/employees?page=4")) && calls.every((c) => c.ok));
r = await admin.get("/settings/integration");
check("the Integration page shows the last sync, its problems and Sync now", r.status === 200 && r.text.includes("Last sync OK") && r.text.includes("Sync now") && r.text.includes("2 problem(s)"));
await sync();
s = await setting("integration.hr_sync");
check("a second sync changes nothing: the same salary version is not recorded twice", s.compensation.recorded === 0 && s.compensation.unchanged >= 2 && (await select("SELECT id FROM salary_history WHERE employee_id = ?", [liza.id])).length === 1, JSON.stringify(s.compensation));
check("every manual sync is audited", (await select("SELECT id FROM audit_logs WHERE action = 'hr_sync_completed'")).length >= 3);

// ---- 2. status changes in HR
await hrCtl("employees", { employee_id: "JV-2026-00903", employment_status: "On Leave" }); // Ivy, Inventory
await sync();
const ivy = await selectOne("SELECT id, employment_status FROM employees WHERE hr_employee_id = 'JV-2026-00903'");
check("On Leave in HR reaches JVzPay through EmployeeStatusChanged (history kept)", ivy.employment_status === "on_leave" && !!(await selectOne("SELECT id FROM employment_history WHERE employee_id = ? AND change_type = 'status_change' AND to_status = 'on_leave'", [ivy.id])));
await admin.submit("/settings/integration", "/settings/integration/tokens", { source: "johnvivz_inventory", name: "Inventory for stage 22" });
const invToken = /(jvz_[A-Za-z0-9_-]{20,})/.exec((await admin.get("/settings/integration")).text)?.[1];
const invLogin = (email, password) => fetch(`${base}/api/integration/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${invToken}` }, body: JSON.stringify({ email, password }) }).then(async (x) => ({ status: x.status, body: await x.json() }));
r = await invLogin("ivy.ramos@gmail.com", "Stock2026ok");
check("an employee On Leave can still sign in to Inventory", r.status === 200 && r.body.employment_status === "on_leave", JSON.stringify(r.body));

const andrea = new Client(base);
await andrea.login("andrea.bautista@gmail.com", "Payday2026ok");
check("Andrea has an ESS session before she resigns", (await andrea.get("/dashboard")).status === 200);
await hrCtl("employees", { ...andreaHr, employment_status: "Resigned" });
const syncDay = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // HR sends no separation date: the day the sync sees it
await sync();
const andreaRow = await selectOne("SELECT e.id, e.employment_status, DATE_FORMAT(e.date_separated, '%Y-%m-%d') AS sep, u.id AS user_id, u.status AS account FROM employees e JOIN users u ON u.employee_id = e.id WHERE e.hr_employee_id = 'JV-2026-00901'");
check("Resigned in HR: separation recorded, ESS account deactivated", andreaRow.employment_status === "resigned" && andreaRow.sep === syncDay && andreaRow.account === "inactive", JSON.stringify(andreaRow));
check("her sessions are ended and the removal is audited", !(await selectOne("SELECT 1 AS x FROM user_sessions WHERE user_id = ?", [andreaRow.user_id])) && !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'ess_access_removed' AND record_id = ?", [String(andreaRow.user_id)])));
r = await andrea.get("/dashboard");
check("her open ESS session no longer works", r.status === 302 && r.loc === "/login", `${r.status} ${r.loc}`);
const { computeSignature, manilaTimestamp } = await import(new URL("../../lib/serviceSignature.js", import.meta.url).href);
const raw = JSON.stringify({ email: "andrea.bautista@gmail.com", password: "Payday2026ok" }), ts = manilaTimestamp(), path = "/api/integration/v1/auth/login";
r = await fetch(`${base}${path}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "X-JVZ-Client": "johnvivz_crm", "X-JVZ-Timestamp": ts, "X-JVZ-Signature": computeSignature(process.env.CRM_INBOUND_SECRET, "POST", path, ts, raw) } }).then(async (x) => ({ status: x.status, body: await x.json() }));
check("CRM's sign-in is refused: 403 not_allowed", r.status === 403 && r.body.error === "not_allowed", JSON.stringify(r.body));

// ---- 3. HR cannot be reached
await hrCtl("down", { down: true });
r = await sync();
s = await setting("integration.hr_sync");
check("a sync while HR is down fails with a clear reason and changes nothing", r.status === 302 && s.ok === false && /could not be reached/.test(s.error), JSON.stringify(s));
check("and is audited", !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'hr_sync_failed'")));
await hrCtl("down", { down: false });

// ---- 4. Inventory's outbox
await invCtl([
  { event_id: "inv-po-0", event_type: "PurchaseOrderCreated", occurred_at: "2026-11-14T08:00:00+08:00", data: { po_number: "PO-501" } },
  { event_id: "inv-po-1", event_type: "PurchaseOrderApproved", occurred_at: "2026-11-14T09:00:00+08:00", data: { po_number: "PO-501", supplier: { id: "SUP-77", name: "Mindoro Rice Traders" }, approved_at: "2026-11-14T09:00:00+08:00", items: [{ sku: "RICE-50", qty: 10, cost: "2400.00" }], total: "24000.00" } },
  { event_id: "inv-gr-1", event_type: "GoodsReceiptRecorded", occurred_at: "2026-11-15T10:00:00+08:00", data: { grn_number: "GRN-501", po_number: "PO-501", received_at: "2026-11-15T10:00:00+08:00", items: [{ sku: "RICE-50", quantity_received: 10, unit_cost: "2400.00" }] } },
  { event_id: "inv-gr-2", event_type: "GoodsReceiptRecorded", data: { grn_number: "GRN-999", po_number: "PO-999", received_at: "2026-11-15", items: [{ sku: "X", quantity_received: 1, unit_cost: "5.00" }] } },
  { event_id: "inv-rf-1", event_type: "RefundReported", data: { refund_no: "RF-1", amount: "100.00" } },
  { event_id: "inv-bad-1", data: { note: "no event type" } },
]);
r = await admin.submit("/settings/integration", "/settings/integration/inventory-poll", {});
let p = await setting("integration.inventory_poll");
check("Poll now reads Inventory's outbox", r.status === 302 && p?.ok === true && p.received === 6 && p.acknowledged === 5 && p.unusable === 1, JSON.stringify(p));
const po = await selectOne("SELECT po.total_amount, s.inventory_ref, s.name FROM purchase_order_references po JOIN suppliers s ON s.id = po.supplier_id WHERE po.purchase_order_id = 'PO-501'");
check("PurchaseOrderApproved (Inventory's field names) becomes a purchase order reference", po?.inventory_ref === "SUP-77" && po.total_amount === "24000.00" && po.name === "Mindoro Rice Traders", JSON.stringify(po));
check("GoodsReceiptRecorded becomes JVzPay's GoodsReceived", !!(await selectOne("SELECT id FROM goods_receipt_references WHERE goods_receipt_id = 'GRN-501' AND purchase_order_id = 'PO-501' AND total_amount = 24000.00")));
const inbox = Object.fromEntries((await select("SELECT event_id, status, result_ref FROM integration_inbox WHERE source = 'johnvivz_inventory' AND event_id LIKE 'inv-%'")).map((x) => [x.event_id, x]));
check("events with no agreed accounting entry are recorded, not posted", inbox["inv-po-0"]?.status === "processed" && /^no entry/.test(inbox["inv-po-0"].result_ref) && inbox["inv-rf-1"]?.status === "processed" && /^no entry/.test(inbox["inv-rf-1"].result_ref), JSON.stringify(inbox));
check("an event that cannot be applied is stored as failed (retry on the Integration page)", inbox["inv-gr-2"]?.status === "failed");
let inv = await invCtl();
check("stored events are acknowledged; an unusable one stays in Inventory's outbox", ["inv-po-0", "inv-po-1", "inv-gr-1", "inv-gr-2", "inv-rf-1"].every((id) => inv.acked.includes(id)) && !inv.acked.includes("inv-bad-1") && inv.calls.every((c) => c.ok));
r = await admin.submit("/settings/integration", "/settings/integration/inventory-poll", {});
p = await setting("integration.inventory_poll");
check("the next poll stores nothing twice", p.ok === true && p.stored === 0 && (await select("SELECT id FROM integration_inbox WHERE event_id LIKE 'inv-%'")).length === 5, JSON.stringify(p));
check("the Integration page shows the poll", (await admin.get("/settings/integration")).text.includes("Last poll OK"));

// ---- 5. HR is pull-only: nothing was ever queued for it
check("no event was queued for HR in the whole run", (await select("SELECT id FROM integration_outbox WHERE target = 'hr'")).length === 0);

report();
await sequelize.close();
process.exit(0);
