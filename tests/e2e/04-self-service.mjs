// Phase 4 end-to-end test. Prerequisite: smoke.mjs has run (creates maria/paolo/grace). Usage: node smoke4.mjs <base>
const base = process.argv[2];
const root = new URL("../../", import.meta.url).href;
const { exec, select, selectOne, sequelize } = await import(root + "lib/db.js");
const results = [];
const check = (name, cond, extra = "") => results.push([cond ? "PASS" : "FAIL", name, extra]);

class Client {
  constructor() { this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); } }
  async req(method, path, body, headers = {}) {
    const r = await fetch(base + path, { method, headers: { cookie: this.cookie(), ...headers }, body, redirect: "manual" });
    this.store(r);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, loc: r.headers.get("location"), type: r.headers.get("content-type"), buf, text: buf.toString("utf8") };
  }
  get(p) { return this.req("GET", p); }
  post(p, data) { return this.req("POST", p, new URLSearchParams(data), { "content-type": "application/x-www-form-urlencoded" }); }
  multipart(p, data, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(data)) fd.append(k, v);
    if (file) fd.append("attachment", new Blob([file.bytes], { type: file.type }), file.name);
    return this.req("POST", p, fd);
  }
  async csrf(p) { const r = await this.get(p); return /name="_csrf" value="([a-f0-9]+)"/.exec(r.text)?.[1]; }
  async login(email, password) { const t = await this.csrf("/login"); return this.post("/login", { _csrf: t, email, password }); }
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from("%PDF-1.4\n% test document\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const FAKE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0)]); // a Windows executable header renamed to .pdf

const maria = new Client(), paolo = new Client(), grace = new Client(), admin = new Client();
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await paolo.login("paolo@johnvivz.local", "Welcome2026ok");
await grace.login("grace@johnvivz.local", "Welcome2026ok");
await admin.login("admin@johnvivz.local", "Ledger2026xyz");

// ---------------------------------------------------------------- navigation & profile
let r = await maria.get("/dashboard");
check("employee nav shows My Workspace", ["/my/profile", "/my/payslips", "/my/attendance", "/my/leave", "/my/bank"].every((h) => r.text.includes(`href="${h}"`)));
check("employee nav hides Approvals", !r.text.includes('href="/bank-enrollments"'));
r = await admin.get("/dashboard");
check("unlinked Accounting Supervisor sees no My Workspace", !r.text.includes('href="/my/profile"'));
r = await admin.get("/my/profile");
check("unlinked account blocked from self-service (403)", r.status === 403);
let t = await maria.csrf("/my/profile");
r = await maria.post("/my/profile", { _csrf: t, email: "maria.new@example.com", phone: "not a phone", municipality: "Bongabong", province: "Oriental Mindoro" });
check("invalid contact rejected (422)", r.status === 422 && r.text.includes("valid phone"));
r = await maria.post("/my/profile", { _csrf: t, email: "maria.new@example.com", phone: "09181112222", address_line: "Purok 3", barangay: "Labonan", municipality: "Bongabong", province: "Oriental Mindoro", basic_salary: "99999" });
check("contact update saved", r.status === 302);
const emp = await selectOne("SELECT id, phone, barangay, basic_salary FROM employees WHERE employee_no = 'JV-0001'");
check("contact persisted; salary untouched by self-service", emp.phone === "09181112222" && emp.barangay === "Labonan" && emp.basic_salary === "560.00", JSON.stringify(emp));

// ---------------------------------------------------------------- upload CSRF hardening
r = await maria.multipart("/my/bank/requests", { bank_name: "LANDBANK" });
check("multipart without CSRF token rejected (403)", r.status === 403);
r = await maria.multipart("/notifications/read-all", { _csrf: t });
check("multipart to a non-upload route rejected (403)", r.status === 403);

// ---------------------------------------------------------------- bank enrollment
t = await maria.csrf("/my/bank?new=1");
const bankBase = { _csrf: t, bank_name: "LANDBANK", account_type: "savings", account_holder_name: "Maria Santos Dela Cruz" };
r = await maria.multipart("/my/bank/requests", { ...bankBase, account_number: "1234567890", account_number_confirm: "1234567891" });
check("mismatched confirmation rejected (422)", r.status === 422 && r.text.includes("do not match"));
check("account number never echoed back into the page", !r.text.includes("1234567890"));
r = await maria.multipart("/my/bank/requests", { ...bankBase, account_number: "12345", account_number_confirm: "12345" });
check("too-short account number rejected", r.status === 422 && r.text.includes("10 to 19 digits"));
r = await maria.multipart("/my/bank/requests", { ...bankBase, bank_name: "GCash", account_type: "e_wallet", account_number: "1234567890", account_number_confirm: "1234567890" });
check("e-wallet requires 09 mobile number", r.status === 422 && r.text.includes("starting with 09"));
r = await maria.multipart("/my/bank/requests", { ...bankBase, account_holder_name: "Juan Santos", account_number: "1234567890", account_number_confirm: "1234567890" });
check("holder-name mismatch requires proof document", r.status === 422 && r.text.includes("Attach proof"));
r = await maria.multipart("/my/bank/requests", { ...bankBase, account_number: "1234-5678-90", account_number_confirm: "1234567890" });
check("valid enrollment submitted", r.status === 302 && r.loc === "/my/bank", `${r.status} ${r.text.match(/alert--error[\s\S]{0,200}/)?.[0]}`);
const req1 = await selectOne("SELECT * FROM bank_enrollment_requests WHERE employee_id = ? ORDER BY id DESC", [emp.id]);
check("stored encrypted, last-4 only in clear", req1 && !req1.account_number_enc.includes("1234567890") && req1.account_number_enc.startsWith("v1:") && req1.account_last4 === "7890");
r = await maria.multipart("/my/bank/requests", { ...bankBase, account_number: "9999999999", account_number_confirm: "9999999999" });
check("second request blocked while one is pending", r.status === 400 && r.text.includes("already have a pending"));

r = await paolo.get("/bank-enrollments");
check("payroll staff review bank enrollments too", r.status === 200);
r = await maria.get("/bank-enrollments");
check("employee blocked from bank review (403)", r.status === 403);
r = await grace.get("/bank-enrollments");
check("supervisor sees pending queue", r.status === 200 && r.text.includes(req1.request_no) && r.text.includes("•••• 7890"));
check("nav shows pending count badge", /Bank Enrollments<\/span>\s*<span class="nav-link__count">1</.test(r.text));
r = await grace.get(`/bank-enrollments/${req1.id}`);
check("detail masks the number", r.text.includes("7890") && !r.text.includes("1234567890"));
t = await grace.csrf(`/bank-enrollments/${req1.id}`);
r = await grace.post(`/bank-enrollments/${req1.id}/reveal`, { _csrf: t });
check("reveal shows full number to reviewer", r.text.includes("1234567890"));
const revealAudit = await selectOne("SELECT * FROM audit_logs WHERE action = 'bank_number_revealed' ORDER BY id DESC");
check("reveal is audited without the number", !!revealAudit && !JSON.stringify(revealAudit).includes("1234567890"));
r = await grace.post(`/bank-enrollments/${req1.id}/decision`, { _csrf: t, action: "reject", remarks: "" });
check("reject without reason refused", r.status === 400 && r.text.includes("reason is required"));
r = await grace.post(`/bank-enrollments/${req1.id}/decision`, { _csrf: t, action: "approve", remarks: "Verified" });
check("supervisor approves", r.status === 302);
r = await grace.post(`/bank-enrollments/${req1.id}/reveal`, { _csrf: t });
check("cannot reveal number of an already-decided request (403)", r.status === 403);
r = await maria.get("/my/bank");
check("employee sees active masked account", r.text.includes("•••• •••• 7890") && r.text.includes("LANDBANK"));
r = await maria.get("/notifications");
check("employee notified of approval", r.text.includes("Bank account approved"));
const allBankAudit = (await select("SELECT previous_value, new_value, remarks FROM audit_logs WHERE module = 'bank'")).map((a) => JSON.stringify(a)).join(" ");
check("no full account number anywhere in the audit log", !allBankAudit.includes("1234567890"));

// update with proof document (name differs) -> approve -> old superseded
t = await maria.csrf("/my/bank?new=1");
r = await maria.multipart("/my/bank/requests", { _csrf: t, bank_name: "BDO Unibank", account_type: "savings", account_holder_name: "Maria D. Cruz-Santos", account_number: "001122334455", account_number_confirm: "001122334455" },
  { bytes: FAKE, type: "application/pdf", name: "passbook.pdf" });
check("disguised executable rejected as attachment", r.status === 422 && r.text.includes("Only PDF, JPG or PNG"));
r = await maria.multipart("/my/bank/requests", { _csrf: t, bank_name: "BDO Unibank", account_type: "savings", account_holder_name: "Maria D. Cruz-Santos", account_number: "001122334455", account_number_confirm: "001122334455" },
  { bytes: PNG, type: "image/png", name: "passbook photo.png" });
check("update request with proof submitted", r.status === 302);
const req2 = await selectOne("SELECT * FROM bank_enrollment_requests WHERE employee_id = ? ORDER BY id DESC", [emp.id]);
check("update typed as 'update' with attachment", req2.request_type === "update" && !!req2.attachment_id);
const doc = await selectOne("SELECT * FROM document_attachments WHERE id = ?", [req2.attachment_id]);
check("attachment stored outside /public with random name", doc && !doc.stored_name.includes("passbook") && doc.mime_type === "image/png");
r = await fetch(base + "/uploads/" + doc.stored_name);
check("upload not reachable as a static file", r.status === 404);
r = await maria.get(`/documents/${doc.id}`);
check("owner can open own document", r.status === 200 && r.type === "image/png");
r = await paolo.get(`/documents/${doc.id}`);
check("a bank-enrollment reviewer (Payroll Staff) can open the proof", r.status === 200);
r = await grace.get(`/documents/${doc.id}`);
check("reviewer can open document", r.status === 200);
t = await grace.csrf(`/bank-enrollments/${req2.id}`);
r = await grace.post(`/bank-enrollments/${req2.id}/decision`, { _csrf: t, action: "approve", remarks: "Matches passbook" });
const accts = await select("SELECT bank_name, status, active_flag FROM bank_accounts WHERE employee_id = ? ORDER BY id", [emp.id]);
check("old account superseded, new one active", accts.length === 2 && accts[0].status === "superseded" && accts[0].active_flag === null && accts[1].status === "active" && accts[1].bank_name === "BDO Unibank", JSON.stringify(accts));

// separation of duties: supervisor's own request
t = await grace.csrf("/my/bank?new=1");
r = await grace.multipart("/my/bank/requests", { _csrf: t, bank_name: "Metrobank", account_type: "savings", account_holder_name: "Grace Villanueva", account_number: "5556667778", account_number_confirm: "5556667778" });
const gReq = await selectOne("SELECT id FROM bank_enrollment_requests WHERE account_last4 = '7778'");
r = await grace.get(`/bank-enrollments/${gReq.id}`);
check("own request shows separation-of-duties warning, no decision form", r.text.includes("Another Accounting Supervisor must review it") && !r.text.includes('value="approve"'));
t = await grace.csrf(`/bank-enrollments/${gReq.id}`);
r = await grace.post(`/bank-enrollments/${gReq.id}/decision`, { _csrf: t, action: "approve", remarks: "self" });
check("supervisor cannot approve own request (403)", r.status === 403);
r = await grace.post(`/bank-enrollments/${gReq.id}/reveal`, { _csrf: t });
check("supervisor cannot reveal own request (403)", r.status === 403);
t = await grace.csrf("/my/bank");
r = await grace.post(`/my/bank/requests/${gReq.id}/cancel`, { _csrf: t });
check("own pending request can be cancelled", r.status === 302);
t = await maria.csrf("/my/bank");
r = await maria.post(`/my/bank/requests/${gReq.id}/cancel`, { _csrf: t });
check("cannot cancel someone else's request (404)", r.status === 404);

// ---------------------------------------------------------------- leave
const nextWeekday = (offset, dow) => { const d = new Date(); d.setDate(d.getDate() + offset); while (d.getDay() !== dow) d.setDate(d.getDate() + 1); return d; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mon = nextWeekday(7, 1);
const tue = new Date(mon); tue.setDate(mon.getDate() + 1);
const wed = new Date(mon); wed.setDate(mon.getDate() + 2);
const nextMon = new Date(mon); nextMon.setDate(mon.getDate() + 7);
const twoWeeksOn = new Date(nextMon); twoWeeksOn.setDate(nextMon.getDate() + 11); // Friday of the week after: 10 work days
const vl = await selectOne("SELECT id FROM leave_types WHERE code = 'VL'"), sl = await selectOne("SELECT id FROM leave_types WHERE code = 'SL'");
r = await maria.get("/my/leave");
check("leave credits initialised from entitlements", r.status === 200 && r.text.includes("Vacation Leave") && r.text.includes("of 10.0 days left"));
t = await maria.csrf("/my/leave");
r = await maria.multipart("/my/leave/applications", { _csrf: t, leave_type_id: vl.id, start_date: iso(tue), end_date: iso(mon), reason: "Family trip" });
check("end before start rejected", r.status === 422 && r.text.includes("cannot be before"));
r = await maria.multipart("/my/leave/applications", { _csrf: t, leave_type_id: vl.id, start_date: iso(mon), end_date: iso(tue), reason: "Family trip to Calapan" });
check("2-day vacation leave submitted", r.status === 302, r.text.match(/alert--error[\s\S]{0,200}/)?.[0]);
let bal = await selectOne("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?", [emp.id, vl.id, mon.getFullYear()]);
check("2 days reserved as pending", bal.pending_days === "2.0", bal.pending_days);
r = await maria.multipart("/my/leave/applications", { _csrf: t, leave_type_id: vl.id, start_date: iso(tue), end_date: iso(wed), reason: "Overlapping request" });
check("overlapping leave rejected", r.status === 400 && r.text.includes("overlaps"));
r = await maria.multipart("/my/leave/applications", { _csrf: t, leave_type_id: vl.id, start_date: iso(nextMon), end_date: iso(twoWeeksOn), reason: "Long vacation request" });
check("insufficient credits rejected (10 days requested, 8 left)", r.status === 400 && r.text.includes("Not enough Vacation Leave credits"), r.text.match(/alert--error[\s\S]{0,200}/)?.[0]);
r = await maria.multipart("/my/leave/applications", { _csrf: t, leave_type_id: sl.id, start_date: iso(nextMon), end_date: iso(wed.getTime() > nextMon.getTime() ? wed : new Date(nextMon.getTime() + 2 * 864e5)), reason: "Fever and flu" });
check("sick leave > 2 days requires a document", r.status === 400 && r.text.includes("requires a supporting document"), r.status + (r.text.match(/alert--error[\s\S]{0,200}/)?.[0] || ""));
r = await maria.multipart("/my/leave/applications", { _csrf: t, leave_type_id: sl.id, start_date: iso(nextMon), end_date: iso(new Date(nextMon.getTime() + 2 * 864e5)), reason: "Fever and flu" }, { bytes: PDF, type: "application/pdf", name: "medcert.pdf" });
check("sick leave with medical certificate accepted", r.status === 302, r.text.match(/alert--error[\s\S]{0,200}/)?.[0]);
r = await grace.get("/notifications");
check("the Accounting Supervisor is asked for the first approval", r.text.includes("Leave for your approval"));
const app1 = await selectOne("SELECT id FROM leave_applications WHERE employee_id = ? AND leave_type_id = ? ORDER BY id LIMIT 1", [emp.id, vl.id]);
t = await maria.csrf("/my/leave");
r = await maria.post(`/my/leave/applications/${app1.id}/cancel`, { _csrf: t });
bal = await selectOne("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?", [emp.id, vl.id, mon.getFullYear()]);
check("cancel returns reserved days", r.status === 302 && bal.pending_days === "0.0");
const lvDoc = await selectOne("SELECT a.attachment_id FROM leave_applications a WHERE a.employee_id = ? AND a.attachment_id IS NOT NULL", [emp.id]);
check("leave document exists", !!lvDoc);
r = await paolo.get(`/documents/${lvDoc?.attachment_id}`);
check("payroll staff (leave.view) can open leave document", r.status === 200 && r.type === "application/pdf");
r = await admin.get(`/documents/${lvDoc?.attachment_id}`);
check("super admin (leave.view) can open leave document", r.status === 200);

// ---------------------------------------------------------------- attendance corrections
const y = new Date(); y.setDate(y.getDate() - 1);
t = await maria.csrf("/my/attendance");
r = await maria.multipart("/my/attendance/corrections", { _csrf: t, work_date: iso(y), requested_status: "present", reason: "Forgot to time in at the front gate" });
check("present without times rejected", r.status === 422 && r.text.includes("Time in is required"));
r = await maria.multipart("/my/attendance/corrections", { _csrf: t, work_date: iso(new Date(Date.now() + 864e5)), requested_status: "present", requested_time_in: "08:00", requested_time_out: "17:00", reason: "Future date attempt" });
check("future date rejected", r.status === 422 && r.text.includes("future date"));
r = await maria.multipart("/my/attendance/corrections", { _csrf: t, work_date: iso(y), requested_status: "present", requested_time_in: "08:02", requested_time_out: "17:05", reason: "Forgot to time in at the front gate" });
check("correction request submitted", r.status === 302, r.text.match(/field__error[^<]*|alert--error[\s\S]{0,200}/g)?.join(" | "));
r = await maria.multipart("/my/attendance/corrections", { _csrf: t, work_date: iso(y), requested_status: "late", requested_time_in: "08:30", requested_time_out: "17:00", reason: "Second request same day" });
check("duplicate pending correction rejected", r.status === 400 && r.text.includes("already have a pending correction"));
r = await maria.get("/my/attendance");
check("request listed as pending", r.text.includes("ACR-") && r.text.includes("Awaiting review"));
const acr = await selectOne("SELECT * FROM attendance_correction_requests WHERE employee_id = ?", [emp.id]);
check("original values snapshot stored (no record → null)", acr.original_status === null && acr.requested_time_in === "08:02:00");

// ---------------------------------------------------------------- payslips (fixture: one released, one not released)
r = await maria.get("/my/payslips");
check("payslips empty state", r.text.includes("No payslips yet"));
const staffUser = await selectOne("SELECT id FROM users WHERE email = 'paolo@johnvivz.local'");
const supUser = await selectOne("SELECT id FROM users WHERE email = 'grace@johnvivz.local'");
const mkPayslip = async (code, release, start, end) => {
  const per = (await exec("INSERT INTO payroll_periods (code,label,pay_frequency,start_date,end_date,pay_date) VALUES (?,?,'semi_monthly',?,?,'2026-11-05')", [code, `${start} to ${end} (${code})`, start, end])).insertId;
  const b = (await exec("INSERT INTO payroll_batches (batch_no, period_id, prepared_by) VALUES (?,?,?)", [`T-${code}`, per, staffUser.id])).insertId;
  const rec = (await exec(`INSERT INTO payroll_records (batch_id, period_id, employee_id, employee_no, employee_name, department_name, position_title, rate_basis, rate_amount,
      days_worked, basic_pay, overtime_pay, allowances, gross_pay, statutory_employee, withholding_tax, other_deductions, total_deductions, net_pay, employer_contributions)
      VALUES (?,?,?,'JV-0001','Maria Santos Dela Cruz','Cashiering','Cashier','daily',560, 13, 7280, 350, 500, 8130, 590.50, 0, 200, 790.50, 7339.50, 1000)`, [b, per, emp.id])).insertId;
  const comp = async (code2) => (await selectOne("SELECT id FROM salary_components WHERE code = ?", [code2])).id;
  await exec("INSERT INTO payroll_earnings (record_id, component_id, description, quantity, rate, amount) VALUES (?,?,?,?,?,?)", [rec, await comp("BASIC"), "Basic pay (13 days × ₱560.00)", 13, 560, 7280]);
  await exec("INSERT INTO payroll_earnings (record_id, component_id, description, quantity, rate, amount) VALUES (?,?,?,?,?,?)", [rec, await comp("OT"), "Overtime (4.00 h)", 4, 87.5, 350]);
  await exec("INSERT INTO payroll_earnings (record_id, component_id, description, amount) VALUES (?,?,?,?)", [rec, await comp("ALLOWANCE"), "Rice allowance", 500]);
  await exec("INSERT INTO payroll_contributions (record_id, agency, base_amount, employee_share, employer_share, ec_share) VALUES (?,?,?,?,?,?)", [rec, "SSS", 8000, 400, 800, 10]);
  await exec("INSERT INTO payroll_contributions (record_id, agency, base_amount, employee_share, employer_share) VALUES (?,?,?,?,?)", [rec, "PHILHEALTH", 10000, 125, 125]);
  await exec("INSERT INTO payroll_contributions (record_id, agency, base_amount, employee_share, employer_share) VALUES (?,?,?,?,?)", [rec, "PAGIBIG", 3275, 65.5, 65]);
  await exec("INSERT INTO payroll_deductions (record_id, component_id, description, amount) VALUES (?,?,?,?)", [rec, await comp("LOAN"), "Salary advance", 200]);
  for (const s of ["approved", "finalized", ...(release ? ["released"] : [])]) await exec("UPDATE payroll_records SET status = ? WHERE id = ?", [s, rec]);
  return (await exec("INSERT INTO payslips (payslip_no, record_id, employee_id, status, generated_by, released_at) VALUES (?,?,?,?,?,?)",
    [`PS-${code}`, rec, emp.id, release ? "released" : "generated", supUser.id, release ? new Date() : null])).insertId;
};
const released = await mkPayslip("TEST-REL", true, "2026-10-16", "2026-10-31");
const unreleased = await mkPayslip("TEST-UNREL", false, "2026-11-01", "2026-11-15");
r = await maria.get("/my/payslips");
check("only released payslip is listed", r.text.includes("PS-TEST-REL") && !r.text.includes("PS-TEST-UNREL") && r.text.includes("₱7,339.50"));
r = await maria.get(`/my/payslips/${unreleased}`);
check("unreleased payslip not viewable (404)", r.status === 404);
r = await maria.get(`/my/payslips/${released}`);
check("payslip detail shows breakdown", r.status === 200 && r.text.includes("Rice allowance") && r.text.includes("Salary advance") && r.text.includes("PhilHealth (employee share)") && r.text.includes("₱8,130.00"));
r = await maria.get(`/my/payslips/${released}/pdf`);
check("payslip PDF downloads", r.status === 200 && r.type === "application/pdf" && r.buf.subarray(0, 5).toString() === "%PDF-", `${r.status} ${r.type}`);
const fs = await import("node:fs");
fs.writeFileSync(process.argv[3] || "payslip-test.pdf", r.buf);
r = await paolo.get(`/my/payslips/${released}`);
check("another employee cannot open the payslip (404)", r.status === 404);
r = await maria.get("/dashboard");
check("employee dashboard shows latest pay and bank", r.text.includes("₱7,339.50") && r.text.includes("BDO Unibank"));

for (const [s, n, e] of results) console.log(`${s}  ${n}${s === "FAIL" && e ? "  → " + e : ""}`);
console.log(`\n${results.filter((x) => x[0] === "PASS").length}/${results.length} passed`);
await sequelize.close();
