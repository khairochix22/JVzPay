// Integration layer: service tokens, the event inbox (HR employee, compensation and status events), idempotency,
// refusals, failed-event retry, the outbox and the HR-sync gate before payroll. Uses only the public API and pages.
import { Client, check, report, db, errText } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, exec, sequelize } = db;

const admin = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");

// ---- tokens: created on the Integration page, shown once, stored as a hash
let r = await admin.get("/settings/integration");
check("integration page opens for the Accounting Supervisor", r.status === 200 && r.text.includes("Service tokens"), errText(r));
async function newToken(source, name) {
  const res = await admin.submit("/settings/integration", "/settings/integration/tokens", { source, name });
  const page = await admin.get("/settings/integration");
  return { res, token: /(jvz_[A-Za-z0-9_-]{20,})/.exec(page.text)?.[1] };
}
const hr = await newToken("johnvivz_hr", "HR test server");
check("token created and shown once", hr.res.status === 302 && !!hr.token);
check("only a hash is stored", !(await selectOne("SELECT id FROM integration_clients WHERE token_hash = ?", [hr.token])));
check("the token is not shown a second time", !(await admin.get("/settings/integration")).text.includes(hr.token));
const crm = await newToken("johnvivz_crm", "CRM test server");

const send = (token, body) => fetch(`${base}/api/v1/events`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
let n = 0;
const ev = (event_type, data, extra = {}) => ({ event_id: `test-${Date.now()}-${++n}`, event_type, schema_version: 1, source: "johnvivz_hr", occurred_at: new Date().toISOString(), entity_id: data.employee_id || data.department_code, data, ...extra });

// ---- authentication and refusals
r = await fetch(`${base}/api/v1/health`, { headers: { authorization: `Bearer ${hr.token}` } });
check("health check answers with the token's source", r.status === 200 && (await r.json()).source === "johnvivz_hr");
check("no token is refused (401)", (await send(null, ev("DepartmentUpserted", { department_code: "X" }))).status === 401);
check("a wrong token is refused (401)", (await send("jvz_wrong", ev("DepartmentUpserted", { department_code: "X" }))).status === 401);
check("a CRM token cannot send HR events (400)", (await send(crm.token, ev("DepartmentUpserted", { department_code: "X" }))).status === 400);
check("an unknown event type is refused (400)", (await send(hr.token, ev("PizzaOrdered", { employee_id: "x" }))).status === 400);
r = await fetch(`${base}/api/v1/events`, { method: "POST", headers: { authorization: `Bearer ${hr.token}`, "content-type": "application/json" }, body: JSON.stringify({ event_type: "EmployeeCreated" }) });
check("an incomplete envelope is refused (400)", r.status === 400);

// ---- HR: departments, a new employee, then a compensation version
r = await send(hr.token, ev("DepartmentUpserted", { department_code: "DELI", department_name: "Deli Counter" }));
check("department event applied (202)", r.status === 202 && r.body.status === "processed", JSON.stringify(r.body));
const hire = ev("EmployeeCreated", {
  employee_id: "HR-777", employee_no: "JV-0777", first_name: "Ramon", last_name: "Tolentino", birth_date: "1995-02-14", email: "ramon@example.com",
  department_code: "DELI", department_name: "Deli Counter", position_title: "Deli Attendant", employment_type: "regular", employment_status: "active",
  date_hired: "2026-10-01", verification_reference: "hr-ramon-77",
});
r = await send(hr.token, hire);
check("employee event applied", r.status === 202, JSON.stringify(r.body));
const ramon = await selectOne("SELECT * FROM employees WHERE hr_employee_id = 'HR-777'");
check("employee snapshot created from HR", !!ramon && ramon.employee_no === "JV-0777" && !!ramon.hr_synced_at && Number(ramon.basic_salary) === 0);
check("verification reference stored only as a hash", !!ramon?.hr_verification_hash && ramon.hr_verification_hash.length === 64 && !JSON.stringify(ramon).includes("hr-ramon-77"));
r = await send(hr.token, hire);
check("the same event again is a harmless duplicate (200)", r.status === 200 && r.body.status === "duplicate");
r = await send(hr.token, { ...hire, event_id: `${hire.event_id}-b`, idempotency_key: "EmployeeCreated:HR-777:1" });
await send(hr.token, { ...hire, event_id: `${hire.event_id}-c`, idempotency_key: "EmployeeCreated:HR-777:1" }).then((x) => check("a repeated idempotency key is a duplicate", x.body.status === "duplicate"));
check("still one employee", (await select("SELECT id FROM employees WHERE hr_employee_id = 'HR-777'")).length === 1);

r = await send(hr.token, ev("EmployeeCompensationApproved", { employee_id: "HR-777", compensation_version_id: "CV-1", basic_salary: "16500.00", rate_basis: "monthly", pay_frequency: "semi_monthly", effective_date: "2026-10-01", approval_reference: "HR-APR-9" }));
check("compensation event applied", r.status === 202, JSON.stringify(r.body));
const sal = await selectOne("SELECT * FROM salary_history WHERE employee_id = ? ORDER BY id DESC LIMIT 1", [ramon.id]);
check("an HR-approved salary version is recorded and effective-dated", !!sal && Number(sal.new_amount) === 16500 && sal.verification_status === "verified" && String(sal.effective_date).slice(0, 10) === "2026-10-01");
r = await send(hr.token, ev("EmployeeCompensationApproved", { employee_id: "HR-777", basic_salary: "18000.00", rate_basis: "monthly", effective_date: "2027-01-01" }));
check("a future salary is kept for later and the current one stays", r.status === 202 && Number((await selectOne("SELECT basic_salary FROM employees WHERE id = ?", [ramon.id])).basic_salary) === 16500
  && (await select("SELECT id FROM salary_history WHERE employee_id = ?", [ramon.id])).length === 2);

// ---- an event that cannot be applied stays in the inbox and can be retried once the cause is fixed
const early = ev("EmployeeStatusChanged", { employee_id: "HR-888", employment_status: "resigned", effective_date: "2026-11-30", separation_date: "2026-11-30" });
r = await send(hr.token, early);
check("an event for an unknown employee is stored as failed (422)", r.status === 422 && r.body.status === "failed" && /not known/.test(r.body.error));
await send(hr.token, ev("EmployeeCreated", { ...hire.data, employee_id: "HR-888", employee_no: "JV-0888", first_name: "Liwayway", email: null, verification_reference: null }));
const failed = await selectOne("SELECT id FROM integration_inbox WHERE event_id = ?", [early.event_id]);
r = await admin.submit("/settings/integration?direction=in", `/settings/integration/inbox/${failed.id}/retry`, {});
const lw = await selectOne("SELECT employment_status, date_separated FROM employees WHERE hr_employee_id = 'HR-888'");
check("retry applies it after the employee arrives", r.status === 302 && lw.employment_status === "resigned" && String(lw.date_separated).slice(0, 10) === "2026-11-30");
check("the retry is audited", !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'integration_event_retried'")));
r = await admin.get("/settings/integration?direction=in");
check("the Integration page lists received events", r.text.includes("EmployeeCompensationApproved") && r.text.includes("EmployeeStatusChanged"));

// ---- payroll refuses employees whose record did not come from HR
const { insertId: local } = await exec(
  `INSERT INTO employees (employee_no, first_name, last_name, department_id, position_id, employment_type, employment_status, date_hired, rate_basis, basic_salary, pay_frequency)
   SELECT 'JV-LOCAL', 'Not', 'From HR', department_id, position_id, 'regular', 'active', '2026-01-01', 'monthly', 15000, 'semi_monthly' FROM employees WHERE id = ?`, [ramon.id]);
const { insertId: periodId } = await exec("INSERT INTO payroll_periods (code, label, cutoff, scope_key, start_date, end_date, pay_date, pay_frequency, status) VALUES ('T-INT', 'Integration test period', 'first_half', 'T-INT', '2026-12-01', '2026-12-15', '2026-12-20', 'semi_monthly', 'open')");
const paolo = new Client(base);
await paolo.login("paolo@johnvivz.local", "Rotated2026ok"); // password changed in stage 12
await paolo.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" }); // stage 13 published a new notice version
r = await paolo.submit("/payroll", `/payroll/periods/${periodId}/compute`, {});
const payrollPage = (await paolo.get("/payroll")).text;
check("payroll is blocked until HR sends the record", r.status === 302 && r.loc === "/payroll" && payrollPage.includes("Not yet received from HR") && payrollPage.includes("JV-LOCAL"), `${r.status} ${r.loc}`);
await exec("UPDATE employees SET deleted_at = NOW() WHERE id = ?", [local]);
await exec("DELETE FROM payroll_periods WHERE id = ?", [periodId]);

// ---- revoked tokens stop working
const hrClient = await selectOne("SELECT id FROM integration_clients WHERE name = 'HR test server'");
await admin.submit("/settings/integration", `/settings/integration/tokens/${hrClient.id}/revoke`, {});
check("a revoked token is refused", (await send(hr.token, ev("DepartmentUpserted", { department_code: "DELI" }))).status === 401);

// ---- outbox: queued while the other application has no address, delivered by the scheduler once it has one
const { enqueue, deliverDue } = await import(new URL("../../services/integrationService.js", import.meta.url).href);
delete process.env.HR_API_URL;
const outId = await enqueue("hr", "PayslipPublished", "PS-TEST", { payslip_no: "PS-TEST" });
await deliverDue();
check("without an HR address the event waits as not connected", (await selectOne("SELECT status FROM integration_outbox WHERE event_id = ?", [outId])).status === "not_connected");

report();
await sequelize.close();
process.exit(0);
