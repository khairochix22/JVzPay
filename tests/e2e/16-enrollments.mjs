// Self-Service enrollments: government numbers (validated, encrypted, masked, applied after verification), dependents
// and benefits (eligibility, verified dependents only), the Payroll Staff queue, no self-verification, and the holiday calendar.
import { Client, check, report, db, errText } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;

const maria = new Client(base), paolo = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await maria.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });
await paolo.login("paolo@johnvivz.local", "Rotated2026ok");
await paolo.submit("/privacy/acknowledge", "/privacy/acknowledge", { agree: "1" });

// ---- government numbers
let r = await maria.get("/my/government");
check("government page shows numbers masked", r.status === 200 && r.text.includes("SSS number") && !r.text.includes("34-1234567-8") && r.text.includes("On file"));
r = await maria.submit("/my/government", "/my/government/requests", { sss: "12345", philhealth: "", pagibig: "", tin: "" });
check("a malformed number is refused", r.status === 422 && r.text.includes("10 digits"));
r = await maria.submit("/my/government", "/my/government/requests", {});
check("an empty request is refused", r.status === 422 && r.text.includes("at least one number"));
r = await maria.multipart("/my/government/requests", { _csrf: await maria.csrf("/my/government"), philhealth: "12-345678901-2", pagibig: "1234-5678-9012" }); // the form posts as multipart (it takes a proof file)
check("valid numbers are submitted", r.status === 302, errText(r));
const gov = await selectOne("SELECT * FROM statutory_enrollments ORDER BY id DESC LIMIT 1");
check("stored encrypted, never in clear", !!gov && !String(gov.philhealth_no_enc).includes("345678901") && gov.status === "pending");
r = await maria.submit("/my/government", "/my/government/requests", { tin: "123456789" });
check("one pending request at a time", r.status === 400 && r.text.includes("already have a pending"));
check("an employee cannot open the queue (403)", (await maria.get("/payroll/enrollments")).status === 403);
r = await paolo.get("/payroll/enrollments");
check("Payroll Staff see it, masked", r.status === 200 && r.text.includes(gov.request_no) && !r.text.includes("345678901"));
r = await paolo.submit("/payroll/enrollments", `/payroll/enrollments/statutory/${gov.id}/decision`, { action: "approve" });
const emp = await selectOne("SELECT philhealth_no_enc, pagibig_no_enc FROM employees WHERE first_name = 'Maria'");
check("verified numbers replace the payroll record", r.status === 302 && emp.philhealth_no_enc === gov.philhealth_no_enc && emp.pagibig_no_enc === gov.pagibig_no_enc);
check("the employee is notified", !!(await selectOne("SELECT id FROM notifications WHERE title = 'Government enrollment approved'")));

// ---- dependents and the two company benefits (HMO: Cocolife ₱250,000, up to 3 immediate family; life and accident
// insurance: up to 2 beneficiaries who are spouse or family)
r = await maria.get("/my/benefits");
check("a regular, active employee is eligible; both company plans are shown", r.status === 200 && r.text.includes("eligible</strong> for the company benefits")
  && r.text.includes("HMO — Cocolife") && r.text.includes("₱250,000.00 coverage") && r.text.includes("Life and accident insurance —") && !r.text.includes(" disabled title="));
r = await maria.submit("/my/benefits", "/my/benefits/dependents", { full_name: "Lito Dela Cruz", relationship: "child", birth_date: "2019-05-02" });
check("a dependent is submitted", r.status === 302, errText(r));
const dep = await selectOne("SELECT * FROM dependent_enrollments ORDER BY id DESC LIMIT 1");
r = await maria.submit("/my/benefits", "/my/benefits/enrollments", { benefit_type: "hmo", dependent_ids: String(dep.id) });
check("an unverified dependent cannot be covered", r.status === 400 && r.text.includes("verified dependents"));
r = await paolo.submit("/payroll/enrollments", `/payroll/enrollments/dependent/${dep.id}/decision`, { action: "reject" });
check("rejecting needs a reason", r.status === 400 && (await selectOne("SELECT status FROM dependent_enrollments WHERE id = ?", [dep.id])).status === "pending");
await paolo.submit("/payroll/enrollments", `/payroll/enrollments/dependent/${dep.id}/decision`, { action: "approve" });
await maria.submit("/my/benefits", "/my/benefits/dependents", { full_name: "Rosa Dela Cruz", relationship: "sibling", birth_date: "2001-03-03" });
const sib = await selectOne("SELECT * FROM dependent_enrollments ORDER BY id DESC LIMIT 1");
await paolo.submit("/payroll/enrollments", `/payroll/enrollments/dependent/${sib.id}/decision`, { action: "approve" });
r = await maria.get("/my/benefits");
check("only verified immediate family can be chosen for the HMO", r.text.includes(`name="dependent_ids" value="${dep.id}"`) && !r.text.includes(`name="dependent_ids" value="${sib.id}"`));
r = await maria.submit("/my/benefits", "/my/benefits/enrollments", { benefit_type: "hmo", dependent_ids: String(sib.id) });
check("a sibling is not immediate family for the HMO", r.status === 400 && r.text.includes("not immediate family"));
r = await maria.submit("/my/benefits", "/my/benefits/enrollments", { benefit_type: "hmo", dependent_ids: String(dep.id) });
check("then the HMO enrollment goes through", r.status === 302, errText(r));
const ben = await selectOne("SELECT * FROM benefit_enrollment_references ORDER BY id DESC LIMIT 1");
check("it is the Cocolife HMO with ₱250,000 coverage covering the child", ben.plan_name === "Cocolife HMO" && ben.coverage_amount === "250000.00" && ben.dependents_count === 1
  && !!(await selectOne("SELECT id FROM benefit_covered_dependents WHERE enrollment_id = ? AND dependent_id = ?", [ben.id, dep.id])));
r = await maria.submit("/my/benefits", "/my/benefits/enrollments", { benefit_type: "life_accident", ben_1_name: "A Friend", ben_1_relationship: "other" });
check("a beneficiary must be spouse or family", r.status === 422 && r.text.includes("spouse or a family member"));
r = await maria.submit("/my/benefits", "/my/benefits/enrollments", { benefit_type: "life_accident", ben_1_name: "Lito Dela Cruz", ben_1_relationship: "child", ben_2_name: "Rosa Dela Cruz", ben_2_relationship: "sibling", ben_2_birth_date: "2001-03-03" });
const ins = await selectOne("SELECT * FROM benefit_enrollment_references WHERE benefit_type = 'life_accident' ORDER BY id DESC LIMIT 1");
const shares = await select("SELECT full_name, share_percent FROM benefit_beneficiaries WHERE enrollment_id = ? ORDER BY id", [ins?.id]);
check("life and accident insurance with two beneficiaries sharing equally", r.status === 302 && shares.length === 2 && shares.every((x) => x.share_percent === "50.00"), errText(r));
r = await paolo.get("/payroll/enrollments");
check("reviewers see who is covered and the beneficiaries", r.text.includes("Covers: Lito Dela Cruz") && r.text.includes("Beneficiaries: Lito Dela Cruz (Child, 50.00%)"));
check("nothing is queued for HR about the dependent (HR is pull-only; HR_EVENTS_ENABLED off)", !(await selectOne("SELECT id FROM integration_outbox WHERE event_type = 'DependentEnrolled'")));
r = await maria.submit("/my/benefits", `/my/benefits/benefit/${ben.id}/cancel`, {});
check("the employee can cancel a pending enrollment", (await selectOne("SELECT status FROM benefit_enrollment_references WHERE id = ?", [ben.id])).status === "cancelled");

// ---- nobody verifies their own request
await paolo.submit("/my/government", "/my/government/requests", { tin: "123-456-789-000" });
const own = await selectOne("SELECT id FROM statutory_enrollments ORDER BY id DESC LIMIT 1");
r = await paolo.submit("/payroll/enrollments", `/payroll/enrollments/statutory/${own.id}/decision`, { action: "approve" });
check("Payroll Staff cannot verify their own numbers (403)", r.status === 403 && (await selectOne("SELECT status FROM statutory_enrollments WHERE id = ?", [own.id])).status === "pending");

// ---- holiday calendar
r = await maria.get("/my/holidays");
check("holiday calendar shows the year and the work schedule", r.status === 200 && r.text.includes("Holiday Calendar") && r.text.includes("Work schedule today") && r.text.includes("plotted by"));

report();
await sequelize.close();
process.exit(0);
