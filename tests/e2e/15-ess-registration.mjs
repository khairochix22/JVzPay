// New-hire account flow (owner's example, 2026-11-13): HR encodes a CRM Agent (with personal email), sends the record;
// the new hire registers in JVzPay with Employee ID, unique code, name, email, department and position; the account is
// active at once; CRM signs the person in through JVzPay's login API; Inventory's application is refused.
// A Payroll/Accounting new hire gets the JVzPay role of their position. Wrong details and duplicates are refused.
import { Client, check, report, db, errText } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;

const admin = new Client(base);
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
async function token(source, name) {
  await admin.submit("/settings/integration", "/settings/integration/tokens", { source, name });
  return /(jvz_[A-Za-z0-9_-]{20,})/.exec((await admin.get("/settings/integration")).text)?.[1];
}
const hrToken = await token("johnvivz_hr", "HR for registration test");
const crmToken = await token("johnvivz_crm", "CRM for registration test");
const invToken = await token("johnvivz_inventory", "Inventory for registration test");
const api = (path, tok, body) => fetch(`${base}/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const hire = (data) => api("/events", hrToken, { event_id: `hire-${data.employee_id}-${Date.now()}`, event_type: "EmployeeCreated", source: "johnvivz_hr", entity_id: data.employee_id, data });

// ---- 1. HR encodes the new hires
check("HR sends a CRM Agent", (await hire({ employee_id: "HR-901", employee_no: "JV-0901", first_name: "Andrea", middle_name: "Lopez", last_name: "Bautista", email: "andrea.bautista@gmail.com",
  department_code: "CRM", department_name: "CRM", position_title: "Agent", employment_type: "regular", employment_status: "active", date_hired: "2026-11-02", verification_reference: "QX-5521-AB" })).status === 202);
check("HR sends a Payroll Staff", (await hire({ employee_id: "HR-902", employee_no: "JV-0902", first_name: "Rico", last_name: "Navarro", email: "rico.navarro@gmail.com",
  department_code: "PAYROLL_ACCOUNTING", department_name: "Payroll/Accounting", position_title: "Payroll Staff", employment_type: "regular", employment_status: "active", date_hired: "2026-11-02", verification_reference: "PZ-1188-KD" })).status === 202);
const crmDept = await selectOne("SELECT id FROM departments WHERE code = 'CRM'");
const accDept = await selectOne("SELECT id FROM departments WHERE code = 'PAYROLL_ACCOUNTING'");

// ---- 2. the CRM agent registers in Payroll/Accounting
const anon = new Client(base);
let r = await anon.get("/register/employee");
check("the registration page is public", r.status === 200 && r.text.includes("Unique code from HR") && r.text.includes("Email you gave HR"));
check("sign-in links to it", (await anon.get("/login")).text.includes('href="/register/employee"'));
const andrea = { employee_no: "jv-0901", verification_code: "qx-5521-ab", full_name: "Andrea L. Bautista", email: "Andrea.Bautista@gmail.com",
  department_id: String(crmDept.id), position_title: "Agent", password: "Payday2026ok", confirm_password: "Payday2026ok", privacy_ack: "1" };
const post = (data) => anon.submit("/register/employee", "/register/employee", data);
check("a wrong unique code is refused", (r = await post({ ...andrea, verification_code: "WRONG-1" })).status === 422 && r.text.includes("do not match"));
check("an email HR did not encode is refused", (r = await post({ ...andrea, email: "someone@gmail.com" })).status === 422 && r.text.includes("do not match"));
check("a different department is refused", (r = await post({ ...andrea, department_id: String(accDept.id) })).status === 422 && r.text.includes("do not match"));
check("a different position is refused", (r = await post({ ...andrea, position_title: "Team Leader" })).status === 422 && r.text.includes("do not match"));
check("a name that is not HR's is refused", (r = await post({ ...andrea, full_name: "Someone Else" })).status === 422 && r.text.includes("do not match"));
check("refusals are audited", (await select("SELECT id FROM audit_logs WHERE action = 'ess_registration_refused'")).length >= 5);
r = await post(andrea);
check("matching details activate the account at once", r.status === 302 && r.loc === "/register/employee/done", `${r.status} ${errText(r)}`);
r = await anon.get("/register/employee/done");
check("the confirmation says to sign in to the CRM application", r.text.includes("Account activated") && r.text.includes("CRM</strong> application"));
const andreaUser = await selectOne("SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = 'andrea.bautista@gmail.com'");
check("account is active, linked to the HR record, Self-Service role", andreaUser?.status === "active" && andreaUser.role_code === "employee" && !!andreaUser.employee_id && andreaUser.must_change_password === 0);
check("no password is kept on the registration record", (await selectOne("SELECT password_hash FROM employee_verification_records WHERE user_id = ?", [andreaUser.id])).password_hash === "");
check("HR is told the account exists (outbox)", !!(await selectOne("SELECT id FROM integration_outbox WHERE event_type = 'EmployeeAccountActivated' AND entity_id = 'HR-901'")));
check("registering twice is refused", (r = await post({ ...andrea, email: "andrea.bautista@gmail.com" })).status === 422 && r.text.includes("already exists"));

// ---- 3. CRM signs the agent in with the credentials made in JVzPay; other departments' applications cannot
r = await api("/auth/login", crmToken, { email: "andrea.bautista@gmail.com", password: "Payday2026ok" });
check("CRM signs the agent in", r.status === 200 && r.body.authenticated === true && r.body.user.department_code === "CRM" && r.body.user.position_title === "Agent" && r.body.user.employee_id === "HR-901", JSON.stringify(r.body));
r = await api("/auth/login", invToken, { email: "andrea.bautista@gmail.com", password: "Payday2026ok" });
check("Inventory's application refuses a CRM agent (403)", r.status === 403 && r.body.authenticated === false);
r = await api("/auth/login", crmToken, { email: "andrea.bautista@gmail.com", password: "Wrong2026xx" });
check("a wrong password is refused (401)", r.status === 401 && r.body.authenticated === false);
r = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "andrea.bautista@gmail.com", password: "Payday2026ok" }) });
check("no service token, no sign-in check (401)", r.status === 401);
check("department sign-ins are audited", !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'department_login'")) && !!(await selectOne("SELECT id FROM audit_logs WHERE action = 'department_login_refused'")));
const selfService = new Client(base);
r = await selfService.login("andrea.bautista@gmail.com", "Payday2026ok");
check("the agent still has Self-Service in JVzPay", r.status === 302 && (await selfService.get("/dashboard")).text.includes("Andrea"));

// ---- 4. a Payroll/Accounting new hire works in JVzPay with the role of the position HR gave
r = await post({ employee_no: "JV-0902", verification_code: "PZ-1188-KD", full_name: "Rico Navarro", email: "rico.navarro@gmail.com", department_id: String(accDept.id), position_title: "Payroll Staff", password: "Ledger2026rn", confirm_password: "Ledger2026rn", privacy_ack: "1" });
check("Payroll/Accounting new hire registers", r.status === 302, `${r.status} ${errText(r)}`);
const rico = await selectOne("SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = 'rico.navarro@gmail.com'");
check("and gets the Payroll Staff role", rico?.code === "payroll_staff");
const ricoClient = new Client(base);
await ricoClient.login("rico.navarro@gmail.com", "Ledger2026rn");
check("and signs in to JVzPay's Payroll Staff dashboard", (await ricoClient.get("/dashboard")).text.includes("Eligible employees"));
check("CRM's application refuses him (403)", (await api("/auth/login", crmToken, { email: "rico.navarro@gmail.com", password: "Ledger2026rn" })).status === 403);

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
