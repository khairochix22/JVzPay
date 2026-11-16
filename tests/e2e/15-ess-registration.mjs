// New-hire account flow (team decision 2026-11-16):
//   1. HR encodes the new hire (Employee ID JV-YYYY-NNNNN + Employee Unique Code). HR is pull-only: JVzPay reads it.
//   2. The new hire registers in ESS; HR checks the details (POST /employees/verify → {match, eligible, mismatches}).
//      Only match + eligible registers; the fields that did not match are named, HR's values never shown; HR down → refused.
//   3. CRM (signed X-JVZ-* request) and Inventory (bearer token) sign their staff in with the department login, which
//      answers only for their own department, ESS-registered, Active/On Leave employees.
// The fake HR answers like the agreed API (fakeApps.mjs). A Payroll/Accounting new hire gets the role of the position.
import { Client, check, report, db, errText, root } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;
const HR = process.env.HR_API_URL;
const hrCtl = (what, body) => fetch(`${HR}/__test/${what}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const { computeSignature, manilaTimestamp } = await import(root + "lib/serviceSignature.js");

const admin = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
await admin.submit("/settings/integration", "/settings/integration/tokens", { source: "johnvivz_inventory", name: "Inventory for registration test" });
const invToken = /(jvz_[A-Za-z0-9_-]{20,})/.exec((await admin.get("/settings/integration")).text)?.[1];
const LOGIN = "/api/integration/v1/auth/login";
const crmLogin = async (body) => {
  const raw = JSON.stringify(body), ts = manilaTimestamp();
  const r = await fetch(`${base}${LOGIN}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "X-JVZ-Client": "johnvivz_crm", "X-JVZ-Timestamp": ts, "X-JVZ-Signature": computeSignature(process.env.CRM_INBOUND_SECRET, "POST", LOGIN, ts, raw) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const invLogin = (body) => fetch(`${base}${LOGIN}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${invToken}` }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// ---- 1. HR's records, pulled by JVzPay ("Sync now")
await hrCtl("departments", [
  { id: 1, code: "PAYROLL_ACCOUNTING", name: "Accounting & Payroll Management" },
  { id: 2, code: "CRM", name: "Customer Relation Management" },
  { id: 3, code: "INVENTORY", name: "Inventory Management" },
]);
const ricoHr = { employee_id: "JV-2026-00902", first_name: "Rico", last_name: "Navarro", email: "rico.navarro@gmail.com", department_id: 1, position: { title: "Payroll Staff" },
  employment_status: "Active", hire_date: "2026-11-02", employee_code: "PZ-1188-KD" };
const ivyHr = { employee_id: "JV-2026-00903", first_name: "Ivy", last_name: "Ramos", email: "ivy.ramos@gmail.com", department_id: 3, position: { title: "Staff" },
  employment_status: "Active", hire_date: "2026-11-03", employee_code: "IV-3030-RS" };
const benHr = { employee_id: "JV-2026-00904", first_name: "Ben", last_name: "Cruz", email: "ben.cruz@gmail.com", department_id: 2, position: { title: "Agent" },
  employment_status: "Resigned", hire_date: "2026-08-01", employee_code: "BN-4040-CZ" };
await hrCtl("employees", [ricoHr, ivyHr, benHr]);
await hrCtl("compensation", [{ employee_id: "JV-2026-00902", basic_salary: "20000.00", rate_basis: "monthly", effective_date: "2026-11-15" }]); // GET /payroll/employees/:id/compensation
// HR's salary bands are configured per position; the seeded "Payroll Staff" position has none in a fresh test database
const payrollStaff = await selectOne("SELECT p.id FROM positions p JOIN departments d ON d.id = p.department_id WHERE d.code = 'PAYROLL_ACCOUNTING' AND p.title = 'Payroll Staff'");
if (payrollStaff) await sequelize.query("INSERT IGNORE INTO position_compensation_bands (position_id, effective_from, minimum_monthly, midpoint_monthly, maximum_monthly, enforcement, benchmark_basis) VALUES (?, '2026-11-13', 18000, 24000, 30000, 'block', 'e2e test band')", { replacements: [payrollStaff.id] });
let r = await admin.submit("/settings/integration", "/settings/integration/hr-sync", {});
const ricoEmp = await selectOne("SELECT * FROM employees WHERE hr_employee_id = 'JV-2026-00902'");
check("Sync now pulls HR's employees (Employee ID, unique code kept for the login answer)", r.status === 302 && ricoEmp?.employee_no === "JV-2026-00902" && ricoEmp.hr_employee_code === "PZ-1188-KD", errText(r));
check("and HR's approved compensation (GET /payroll/employees/:id/compensation)", !!(await selectOne("SELECT id FROM salary_history WHERE employee_id = ? AND new_amount = 20000.00 AND verification_status = 'verified'", [ricoEmp?.id])));
const crmDept = await selectOne("SELECT id FROM departments WHERE code = 'CRM'");
const accDept = await selectOne("SELECT id FROM departments WHERE code = 'PAYROLL_ACCOUNTING'");

// ---- 2. the CRM agent is encoded in HR after that sync, and registers in ESS
await hrCtl("employees", { employee_id: "JV-2026-00901", first_name: "Andrea", middle_name: "Lopez", last_name: "Bautista", email: "andrea.bautista@gmail.com", department_id: 2, position: { title: "Agent" },
  employment_status: "Active", hire_date: "2026-11-02", employee_code: "QX-5521-AB" });
check("she is not in JVzPay yet", !(await selectOne("SELECT id FROM employees WHERE hr_employee_id = 'JV-2026-00901'")));
const anon = new Client(base);
r = await anon.get("/register/employee");
check("the registration page is public", r.status === 200 && r.text.includes("Unique code from HR") && r.text.includes("Email you gave HR"));
check("sign-in links to it", (await anon.get("/login")).text.includes('href="/register/employee"'));
const andrea = { employee_no: "jv-2026-00901", verification_code: "qx-5521-ab", full_name: "Andrea L. Bautista", email: "Andrea.Bautista@gmail.com",
  department_id: String(crmDept.id), position_title: "Agent", password: "Payday2026ok", confirm_password: "Payday2026ok", privacy_ack: "1" };
const post = (data) => anon.submit("/register/employee", "/register/employee", data);
const refused = (res, label) => res.status === 422 && res.text.includes("do not match HR") && res.text.includes(`These do not match: ${label}`);
check("a wrong unique code is refused, naming the field", refused(r = await post({ ...andrea, verification_code: "WRONG-1" }), "Unique code"), errText(r));
check("HR's own value is never shown", !r.text.includes("QX-5521-AB"));
// several wrong fields at once (registration allows 10 attempts per hour per device, so the checks are combined)
r = await post({ ...andrea, email: "someone@gmail.com", department_id: String(accDept.id), position_title: "Team Leader", full_name: "Someone Else" });
check("a wrong email, department, position and name are refused, each named", refused(r, "Full name, Email, Department, Position"), errText(r));
check("an Employee ID HR does not know is refused", refused(await post({ ...andrea, employee_no: "JV-2026-99999" }), "Employee ID"));
check("refusals are audited with the fields", (await select("SELECT remarks FROM audit_logs WHERE action = 'ess_registration_refused' AND remarks LIKE 'Did not match HR:%'")).length >= 3);
r = await post({ employee_no: "JV-2026-00904", verification_code: "BN-4040-CZ", full_name: "Ben Cruz", email: "ben.cruz@gmail.com", department_id: String(crmDept.id), position_title: "Agent", password: "Payday2026ok", confirm_password: "Payday2026ok", privacy_ack: "1" });
check("an employee HR says is not eligible (resigned) is refused", r.status === 422 && r.text.includes("cannot register"), errText(r));
await hrCtl("down", { down: true });
r = await post(andrea);
check("when HR cannot be reached the registration is refused (no offline registration)", r.status === 400 && r.text.includes("could not be reached") && !(await selectOne("SELECT id FROM users WHERE email = 'andrea.bautista@gmail.com'")), errText(r));
await hrCtl("down", { down: false });
r = await post(andrea);
check("matching details activate the account at once", r.status === 302 && r.loc === "/register/employee/done", `${r.status} ${errText(r)}`);
r = await anon.get("/register/employee/done");
check("the confirmation says to sign in to the CRM application (HR's department name)", r.text.includes("Account activated") && r.text.includes("Customer Relation Management</strong> application"));
const andreaUser = await selectOne("SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = 'andrea.bautista@gmail.com'");
check("account is active, linked to the HR record, Self-Service role", andreaUser?.status === "active" && andreaUser.role_code === "employee" && !!andreaUser.employee_id && andreaUser.must_change_password === 0);
check("her HR record was fetched from HR on registration", !!(await selectOne("SELECT id FROM employees WHERE id = ? AND hr_employee_id = 'JV-2026-00901' AND hr_employee_code = 'QX-5521-AB'", [andreaUser?.employee_id])));
check("the registration is recorded as checked by HR's API", (await selectOne("SELECT hr_check, password_hash FROM employee_verification_records WHERE user_id = ?", [andreaUser?.id]))?.hr_check === "hr_api");
const calls = await hrCtl("calls");
check("JVzPay called HR's verify with the API key", calls.some((c) => c.method === "POST" && c.path === "/api/integration/v1/employees/verify" && c.ok) && calls.every((c) => c.ok));
check("nothing is queued for HR (HR is pull-only)", !(await selectOne("SELECT id FROM integration_outbox WHERE target = 'hr' AND event_type = 'EmployeeAccountActivated'")));
check("registering twice is refused", (r = await post({ ...andrea, email: "andrea.bautista@gmail.com" })).status === 422 && r.text.includes("already exists"));

// ---- 3. department login: CRM signs with HMAC, Inventory with a bearer token
r = await crmLogin({ email: "andrea.bautista@gmail.com", password: "Payday2026ok" });
check("CRM signs the agent in (200, the agreed fields only)", r.status === 200 && JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(["department_code", "department_name", "email", "employee_code", "employee_id", "employment_status", "ess_registered_at", "full_name", "position"]), JSON.stringify(r.body));
check("with HR's Employee ID, unique code, department and position", r.body.employee_id === "JV-2026-00901" && r.body.employee_code === "QX-5521-AB" && r.body.department_code === "CRM" && r.body.position === "Agent" && r.body.employment_status === "active" && /\+08:00$/.test(r.body.ess_registered_at || ""), JSON.stringify(r.body));
r = await invLogin({ email: "andrea.bautista@gmail.com", password: "Payday2026ok" });
check("Inventory's application refuses a CRM agent: 403 not_allowed", r.status === 403 && r.body.error === "not_allowed", JSON.stringify(r.body));
const wrong = await crmLogin({ email: "andrea.bautista@gmail.com", password: "Wrong2026xx" });
const unknown = await crmLogin({ email: "nobody@gmail.com", password: "Payday2026ok" });
const unregistered = await crmLogin({ email: "ramon@example.com", password: "Payday2026ok" }); // in HR's records (stage 14), no ESS account
check("a wrong password, an unknown email and an unregistered employee get the same 401 invalid_credentials",
  [wrong, unknown, unregistered].every((x) => x.status === 401 && JSON.stringify(x.body) === '{"error":"invalid_credentials"}'), JSON.stringify([wrong, unknown, unregistered]));
r = await fetch(`${base}${LOGIN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "andrea.bautista@gmail.com", password: "Payday2026ok" }) });
check("no service credentials, no sign-in check (401)", r.status === 401);
check("every attempt is audited", (await select("SELECT id FROM audit_logs WHERE action IN ('department_login','department_login_refused')")).length >= 5);
const selfService = new Client(base);
r = await selfService.login("andrea.bautista@gmail.com", "Payday2026ok");
check("the agent still has Self-Service in JVzPay", r.status === 302 && (await selfService.get("/dashboard")).text.includes("Andrea"));

// an Inventory staff member: Inventory signs her in with its token
r = await post({ employee_no: "JV-2026-00903", verification_code: "IV-3030-RS", full_name: "Ivy Ramos", email: "ivy.ramos@gmail.com", department_id: String((await selectOne("SELECT id FROM departments WHERE code = 'INVENTORY'")).id), position_title: "Staff", password: "Stock2026ok", confirm_password: "Stock2026ok", privacy_ack: "1" });
check("an Inventory new hire registers", r.status === 302, errText(r));
r = await invLogin({ email: "ivy.ramos@gmail.com", password: "Stock2026ok" });
check("Inventory signs its staff in with a bearer token", r.status === 200 && r.body.department_code === "INVENTORY" && r.body.employee_id === "JV-2026-00903", JSON.stringify(r.body));
check("CRM cannot sign an Inventory employee in (403)", (await crmLogin({ email: "ivy.ramos@gmail.com", password: "Stock2026ok" })).status === 403);

// ---- 4. a Payroll/Accounting new hire works in JVzPay with the role of the position HR gave
r = await post({ employee_no: "JV-2026-00902", verification_code: "PZ-1188-KD", full_name: "Rico Navarro", email: "rico.navarro@gmail.com", department_id: String(accDept.id), position_title: "Payroll Staff", password: "Ledger2026rn", confirm_password: "Ledger2026rn", privacy_ack: "1" });
check("Payroll/Accounting new hire registers", r.status === 302, `${r.status} ${errText(r)}`);
const rico = await selectOne("SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = 'rico.navarro@gmail.com'");
check("and gets the Payroll Staff role", rico?.code === "payroll_staff");
const ricoClient = new Client(base);
await ricoClient.login("rico.navarro@gmail.com", "Ledger2026rn");
check("and signs in to JVzPay's Payroll Staff dashboard", (await ricoClient.get("/dashboard")).text.includes("Eligible employees"));
check("CRM's application refuses him (403)", (await crmLogin({ email: "rico.navarro@gmail.com", password: "Ledger2026rn" })).status === 403);

// ---- 5. the registration log
const paolo = new Client(base);
await paolo.login("paolo@johnvivz.local", "Rotated2026ok"); // password changed in stage 12
await paolo.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" }); // stage 13 published a new notice version
r = await paolo.get("/users/registrations");
check("Payroll Staff see the registrations", r.status === 200 && r.text.includes("Andrea L. Bautista") && r.text.includes("Rico Navarro"));
const maria = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await maria.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
check("an employee cannot open them (403)", (await maria.get("/users/registrations")).status === 403);

report();
await sequelize.close();
process.exit(0);
