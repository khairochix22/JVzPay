// Accounts and access: first sign-in, roles, removed HR pages, and Accounting Staff account requests.
// Employee records come from HR; hrFixture() stands in for that sync until the HR database is connected.
import { Client, check, report, db, errText, hrFixture } from "./lib.mjs";

const [base, adminEmail, adminPass] = process.argv.slice(2);
const { select, selectOne, sequelize } = db;
const NEWPW = "Ledger2026xyz";

// ---- Accounting Supervisor first sign-in
const admin = new Client(base);
let r = await admin.login(adminEmail, "wrong-password-1");
check("bad password rejected with generic message", r.status === 401 && r.text.includes("Invalid email or password"));
r = await admin.login(adminEmail, adminPass);
check("admin login redirects to forced password change", r.status === 302 && r.loc === "/account/password", r.loc);
r = await admin.get("/dashboard");
check("forced change blocks dashboard", r.status === 302 && r.loc === "/account/password");
let t = await admin.csrf("/account/password");
r = await admin.post("/account/password", { _csrf: t, current_password: adminPass, new_password: "short", confirm_password: "short" });
check("weak password rejected", r.status === 422);
r = await admin.post("/account/password", { _csrf: t, current_password: adminPass, new_password: NEWPW, confirm_password: NEWPW });
check("password changed", r.status === 302 && r.loc === "/dashboard");
r = await admin.get("/dashboard");
check("the privacy notice comes first", r.status === 302 && r.loc === "/privacy/acknowledge");
t = await admin.csrf("/privacy/acknowledge");
r = await admin.post("/privacy/acknowledge", { _csrf: t });
check("acknowledging needs the box ticked", r.status === 422);
r = await admin.post("/privacy/acknowledge", { _csrf: t, agree: "1" });
check("acknowledged, then on to the dashboard", r.status === 302 && r.loc === "/dashboard");
r = await admin.get("/dashboard");
check("supervisor dashboard renders for admin", r.status === 200 && r.text.includes("Financial performance") && r.text.includes("Net profit this month") && r.text.includes("Accounts payable"));
check("admin nav shows User Accounts and Account Requests", r.text.includes('href="/users"') && r.text.includes('href="/users/requests"'));
check("admin nav no longer shows Employees or Departments", !r.text.includes('href="/employees"') && !r.text.includes('href="/organization"'));
for (const p of ["/employees", "/employees/new", "/organization", "/users/new"]) check(`${p} is gone (404)`, (await admin.get(p)).status === 404);
r = await admin.post("/users/requests/1/decision", { action: "approve" });
check("POST without CSRF token rejected", r.status === 403);

// ---- employees and their logins arrive from HR
const hr = await hrFixture();
check("HR records loaded", (await select("SELECT id FROM employees")).length === 3);
async function firstLogin(email, pw) {
  const c = new Client(base);
  await c.login(email, pw);
  const tk = await c.csrf("/account/password");
  await c.post("/account/password", { _csrf: tk, current_password: pw, new_password: "Welcome2026ok", confirm_password: "Welcome2026ok" });
  await c.post("/privacy/acknowledge", { _csrf: await c.csrf("/privacy/acknowledge"), agree: "1" });
  return c;
}
const emp = await firstLogin("maria@johnvivz.local", hr.temp.maria);
const staff = await firstLogin("paolo@johnvivz.local", hr.temp.paolo);
const sup = await firstLogin("grace@johnvivz.local", hr.temp.grace);
await firstLogin("carla@johnvivz.local", hr.temp.carla);

r = await emp.get("/dashboard");
check("employee dashboard renders own data", r.status === 200 && r.text.includes("Hi, Maria") && r.text.includes("Leave credits"));
check("employee nav hides Users/Audit", !r.text.includes('href="/users"') && !r.text.includes('href="/audit"'));
check("employee blocked from users (403)", (await emp.get("/users")).status === 403);
r = await emp.get("/my/profile");
check("employee profile masks government IDs", r.status === 200 && !r.text.includes("34-1234567-8") && r.text.includes("•"));
r = await staff.get("/dashboard");
check("staff dashboard renders", r.status === 200 && r.text.includes("Eligible employees") && r.text.includes("Net payroll"));
check("staff blocked from audit (403)", (await staff.get("/audit")).status === 403);
check("staff blocked from account requests (403)", (await staff.get("/users/requests")).status === 403);
r = await sup.get("/dashboard");
check("supervisor dashboard renders", r.status === 200 && r.text.includes("Pending approvals") && r.text.includes("Cash flow"));
r = await sup.get("/audit");
check("supervisor sees the full audit trail", r.status === 200 && !r.text.includes("Payroll-related history"));

// ---- Accounting Staff ask for an account
const anon = new Client(base);
r = await anon.get("/register");
check("sign-up page is public", r.status === 200 && r.text.includes("Unique code from HR") && r.text.includes("not connected yet"));
check("sign-in page links to it", (await anon.get("/login")).text.includes('href="/register"'));
// the form offers the departments and positions on record; Liza picks Payroll/Accounting → Accounting Staff
const adminDeptId = (await selectOne("SELECT id FROM departments WHERE code = 'PAYROLL_ACCOUNTING'")).id;
const good = { full_name: "Liza Manalo", employee_no: "jv-0101", department_id: String(adminDeptId), position_title: "Accounting Staff", hr_code: "HR-7Q2X-91", email: "Liza@johnvivz.local", password: "Ledger2026abc", confirm_password: "Ledger2026abc", privacy_ack: "1" };
t = await anon.csrf("/register");
r = await anon.post("/register", { _csrf: t, ...good, full_name: "", password: "short" });
check("incomplete request refused", r.status === 422 && r.text.includes("Enter your full name") && r.text.includes("at least 10 characters"));
r = await anon.post("/register", { _csrf: t, ...good, privacy_ack: "" });
check("the Privacy Notice must be acknowledged to sign up", r.status === 422 && r.text.includes("Confirm that you have read the Privacy Notice"));
r = await anon.post("/register", { _csrf: t, ...good });
check("request sent", r.status === 302 && r.loc === "/register/sent", `${r.status} ${errText(r)}`);
check("confirmation page", (await anon.get("/register/sent")).text.includes("Request sent"));
const req1 = await selectOne("SELECT * FROM account_requests WHERE email = 'liza@johnvivz.local'");
check("request stored with normalized email and ID", !!req1 && req1.employee_no === "JV-0101" && req1.status === "pending" && req1.hr_check === "not_connected");
check("HR code is encrypted and password hashed", !!req1 && !req1.hr_code_enc.includes("HR-7Q2X") && req1.password_hash.startsWith("$2"));
r = await anon.post("/register", { _csrf: t, ...good });
check("second request for the same person refused", r.status === 422 && r.text.includes("already waiting"));
r = await anon.post("/register", { _csrf: t, ...good, employee_no: "JV-0199", email: "maria@johnvivz.local" });
check("email of an existing account refused", r.status === 422 && r.text.includes("already exists"));
r = await new Client(base).login("liza@johnvivz.local", "Ledger2026abc");
check("pending request explained at sign-in", r.status === 401 && r.text.includes("waiting for approval"));
r = await new Client(base).login("liza@johnvivz.local", "Wrong2026abc");
check("wrong password still gets the generic message", r.status === 401 && r.text.includes("Invalid email or password"));

r = await admin.get("/notifications");
check("Accounting Supervisor notified of the request", r.text.includes("Accounting staff account requested"));
r = await admin.get("/users/requests");
check("request listed as not checked with HR", r.text.includes("Liza Manalo") && r.text.includes("Not checked") && r.text.includes("HR verification is pending"));
t = await admin.csrf(`/users/requests/${req1.id}`);
r = await admin.post(`/users/requests/${req1.id}/decision`, { _csrf: t, action: "reject", remarks: "" });
check("rejecting needs a reason", r.status === 400 && r.text.includes("Give a reason"));
r = await admin.post(`/users/requests/${req1.id}/decision`, { _csrf: t, action: "approve", remarks: "Confirmed with HR by phone" });
check("request approved", r.status === 302, errText(r));
const liza = await selectOne("SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = 'liza@johnvivz.local'");
check("Accounting Staff account created, no forced change", !!liza && liza.role_code === "accounting_staff" && liza.must_change_password === 0 && liza.employee_id === null);
r = await admin.post(`/users/requests/${req1.id}/decision`, { _csrf: t, action: "approve" });
check("a decided request cannot be decided again", r.status === 400 && r.text.includes("already decided"));

const acct = new Client(base);
r = await acct.login("liza@johnvivz.local", "Ledger2026abc");
check("accounting staff sign in with the password they chose", r.status === 302 && r.loc === "/dashboard", r.loc);
r = await acct.get("/dashboard");
check("accounting staff dashboard", r.status === 200 && r.text.includes("Your accounting workspace") && r.text.includes("My entries awaiting approval"), errText(r));
check("accounting nav, no payroll or users", r.text.includes('href="/accounting/income"') && !r.text.includes('href="/payroll/batches"') && !r.text.includes('href="/users"'));
for (const p of ["/payroll", "/analytics", "/users", "/accounting/approvals"]) check(`accounting staff blocked from ${p} (403)`, (await acct.get(p)).status === 403);
// Accounting Staff decide employees' requests (owner, 2026-11-13), so they see attendance
check("accounting staff open attendance to decide corrections", (await acct.get("/attendance")).status === 200);
check("accounting staff can open expenses", (await acct.get("/accounting/expenses")).status === 200);
check("accounting staff can open financial reports", (await acct.get("/reports/income-statement")).status === 200);

t = await anon.csrf("/register");
await anon.post("/register", { _csrf: t, ...good, full_name: "Ben Cruz", employee_no: "JV-0102", email: "ben@johnvivz.local" });
const req2 = await selectOne("SELECT id FROM account_requests WHERE email = 'ben@johnvivz.local'");
t = await admin.csrf(`/users/requests/${req2.id}`);
await admin.post(`/users/requests/${req2.id}/decision`, { _csrf: t, action: "reject", remarks: "Not on the accounting team" });
r = await new Client(base).login("ben@johnvivz.local", "Ledger2026abc");
check("rejection reason shown at sign-in", r.status === 401 && r.text.includes("Not on the accounting team"));
check("rejected request keeps its details", (await selectOne("SELECT full_name, decision_remarks FROM account_requests WHERE id = ?", [req2.id])).full_name === "Ben Cruz");
r = await admin.get("/audit?q=account_request");
check("decisions are in the audit trail", r.text.includes("Account Request Approved") && r.text.includes("Account Request Rejected"));

// ---- guard rails
const roleIds = Object.fromEntries((await select("SELECT id, code FROM roles")).map((x) => [x.code, x.id]));
const self = await selectOne("SELECT id FROM users WHERE email = ?", [adminEmail]);
t = await admin.csrf(`/users/${self.id}/edit`);
r = await admin.post(`/users/${self.id}`, { _csrf: t, full_name: "System Administrator", email: adminEmail, role_id: roleIds.employee, status: "active", employee_id: hr.ids.maria });
check("admin cannot demote self", r.status === 422);

const bad = new Client(base);
for (let i = 0; i < 3; i++) await bad.login("maria@johnvivz.local", "nope-" + i);
r = await bad.login("maria@johnvivz.local", "Welcome2026ok");
check("account locks after 3 failures (correct password refused)", r.status === 401);

t = await emp.csrf("/dashboard");
await emp.post("/logout", { _csrf: t });
r = await emp.get("/dashboard");
check("logout ends session", r.status === 302 && r.loc === "/login");
check("404 page", (await admin.get("/does-not-exist")).status === 404);

report();
await sequelize.close();
