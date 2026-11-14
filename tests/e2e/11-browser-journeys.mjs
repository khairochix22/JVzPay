// The four user journeys from the system specification, walked in a real browser from a brand-new database.
// Everything goes through the rendered pages: typing, dropdowns, confirmation dialogs and uploads-capable forms.
import os from "node:os";
import path from "node:path";
import { check, report, db, iso, daysFrom, hrFixture } from "./lib.mjs";
import { openBrowser } from "./browser.mjs";

const [base, adminEmail, adminPass] = process.argv.slice(2);
const page = await openBrowser(base);
const PASSWORD = "Journey2026xyz";

// Runs a named step; a failure is recorded with what the page said, and the journey carries on.
async function step(name, fn) {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    const shot = path.join(os.tmpdir(), `jvzpay-fail-${name.replace(/\W+/g, "-").slice(0, 40)}.png`);
    await page.screenshot(shot).catch(() => {});
    check(name, false, `${e.message} [${await page.url().catch(() => "?")}] ${shot}`);
  }
}
const expect = (cond, message) => { if (!cond) throw new Error(message); };
async function expectSuccess(label) {
  const ok = await page.success();
  expect(ok, `${label}: no success message. Page says: ${(await page.messages()).join(" | ") || (await page.text()).slice(0, 200)}`);
  return ok;
}
const signOut = () => page.submit('form[action="/logout"]');

async function firstSignIn(email, temporary) {
  await page.login(email, temporary);
  expect((await page.url()).startsWith("/account/password"), `expected the password page, got ${await page.url()}`);
  await page.set("current_password", temporary);
  await page.set("new_password", PASSWORD);
  await page.set("confirm_password", PASSWORD);
  await page.submit('form[action="/account/password"]');
  if ((await page.url()).startsWith("/login")) await page.login(email, PASSWORD);
  if ((await page.url()).startsWith("/privacy/acknowledge")) {
    await page.tick('[name="agree"]');
    await page.submit('form[action="/privacy/acknowledge"]');
  }
}

// dates: the first half of last month is safely in the past
const now = new Date();
const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(), m = now.getMonth() === 0 ? 12 : now.getMonth();
const ym = `${y}-${String(m).padStart(2, "0")}`;
const workdays = [];
for (let d = 1; d <= 15 && workdays.length < 3; d++) if (![0, 6].includes(new Date(y, m - 1, d).getDay())) workdays.push(`${ym}-${String(d).padStart(2, "0")}`);
const nextMonday = (() => { const d = daysFrom(7); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d; })();
const tuesday = new Date(nextMonday.getTime() + 864e5);

const temp = {};

// ---- Accounting Supervisor: Login → Dashboard → Employee Management → ... → System Settings
await step("Accounting Supervisor must set a new password on first sign-in", () => firstSignIn(adminEmail, adminPass));
await step("Accounting Supervisor lands on the dashboard", async () => {
  expect((await page.url()).startsWith("/dashboard"), await page.url());
  expect((await page.text()).includes("Welcome back"), "no welcome section");
});
await step("HR records and logins arrive (stand-in for the HR system)", async () => {
  Object.assign(temp, (await hrFixture()).temp);
  expect(temp.maria && temp.paolo && temp.grace, "fixture passwords");
});
await step("verify the statutory rules and tax table", async () => {
  await page.goto("/payroll/setup/statutory");
  for (let i = 0; i < 6 && await page.has('form[action$="/verify"]'); i++) await page.submit('form[action$="/verify"]');
  expect(!(await page.has('form[action$="/verify"]')), "rules left unverified");
  await page.goto("/payroll/setup/tax");
  await page.submit('form[action="/payroll/setup/tax/verify"]');
  await expectSuccess("tax table");
});
await step("day and dark theme switch and stay switched", async () => {
  await page.goto("/analytics");
  const bg = () => page.ev("getComputedStyle(document.body).backgroundColor");
  const day = await bg();
  await page.ev("document.querySelector('.topbar [data-theme-toggle]').click()");
  // one click only; allow the page a moment in case the browser was still finishing the navigation
  for (let i = 0; i < 20 && (await page.ev("document.documentElement.dataset.theme")) !== "dark"; i++) await new Promise((r) => setTimeout(r, 50));
  expect((await page.ev("document.documentElement.dataset.theme")) === "dark", "not dark after the click");
  expect((await bg()) !== day, "the page did not change colour");
  await page.goto("/payroll/setup/tax");
  expect((await page.ev("document.documentElement.dataset.theme")) === "dark", "the choice was not kept on the next page");
  expect((await page.ev("document.querySelector('.topbar [data-theme-toggle]').getAttribute('aria-label')")) === "Switch to day theme", "button label");
  await page.ev("document.querySelector('.topbar [data-theme-toggle]').click()");
  expect((await page.ev("document.documentElement.dataset.theme")) === "light", "not back to day");
});
await step("top-bar search finds pages and reports, and Enter opens the first match", async () => {
  await page.viewport(1440, 900, false); // the search box is part of the desktop and tablet top bar; phones use the drawer
  await page.goto("/dashboard");
  const type = (q) => page.ev(`(() => { const i = document.querySelector(".search-box__input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return [...document.querySelectorAll(".search-box__hit a")].map((a) => a.getAttribute("href")); })()`);
  const hits = await type("balance");
  expect(hits.includes("/reports/balance-sheet"), `"balance" found ${hits.join(", ") || "nothing"}`);
  expect((await type("payslips")).includes("/payroll/payslips"), "a sidebar page was not found");
  expect((await type("zzzz")).length === 0 && (await page.text()).includes("No page or report matches"), "no empty message");
  await type("trial");
  await page.ev("window.__jvz = 1");
  await page.ev(`document.querySelector(".search-box__input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
  await page.settle();
  expect((await page.url()).startsWith("/reports/trial-balance"), await page.url());
});
await step("sidebar sections open, close and stay open on the next page", async () => {
  const sec = (name) => `document.querySelector('[data-nav-sec="${name}"]')`;
  await page.goto("/dashboard");
  expect(!(await page.ev(`${sec("Accounting")}.classList.contains("is-open")`)), "Accounting should start closed on the dashboard");
  await page.ev(`${sec("Accounting")}.querySelector("[data-nav-toggle]").click()`);
  expect(await page.ev(`${sec("Accounting")}.querySelector("[data-nav-toggle]").getAttribute("aria-expanded") === "true"`), "did not open");
  await page.goto("/payroll/batches");
  expect(await page.ev(`${sec("Accounting")}.classList.contains("is-open")`), "the open section was not remembered");
  expect(await page.ev(`${sec("Payroll")}.classList.contains("is-open")`), "the current page's section is closed");
  await page.ev(`${sec("Accounting")}.querySelector("[data-nav-toggle]").click()`);
});
await step("Accounting Supervisor signs out", async () => {
  await signOut();
  expect((await page.url()).startsWith("/login"), await page.url());
});
await step("sign-in page: the eye shows the password and the email can be remembered", async () => {
  const eye = `document.querySelector('[data-toggle-password="password"]')`;
  await page.ev(`${eye}.click()`);
  expect((await page.ev(`document.getElementById("password").type`)) === "text", "the password was not shown");
  expect((await page.ev(`${eye}.getAttribute("aria-label")`)) === "Hide password", "the button label did not change");
  await page.ev(`${eye}.click()`);
  expect((await page.ev(`document.getElementById("password").type`)) === "password", "the password was not hidden again");
  await page.set("email", adminEmail);
  await page.set("password", PASSWORD);
  await page.tick("#remember-email");
  await page.submit('form[action="/login"]');
  await signOut();
  expect((await page.value("#email")) === adminEmail, `the email was not remembered: "${await page.value("#email")}"`);
  await page.ev(`document.getElementById("remember-email").checked = false`);
  await page.set("password", PASSWORD);
  await page.submit('form[action="/login"]');
  await signOut();
  expect(!(await page.value("#email")), "the email was still remembered after unticking");
});

// ---- Accounting Staff: request an account, wait for approval, record an expense
await step("accounting staff request an account", async () => {
  await page.goto("/register");
  const f = 'form[action="/register"]';
  for (const [k, v] of Object.entries({ full_name: "Liza Manalo", employee_no: "JV-0101", department_id: "Payroll/Accounting", position_title: "Accounting Staff", hr_code: "HR-7Q2X-91", email: "liza@johnvivz.local", password: PASSWORD, confirm_password: PASSWORD })) await page.set(k, v, f);
  await page.tick('[name="privacy_ack"]');
  await page.submit(f);
  expect((await page.url()) === "/register/sent", await page.url());
});
await step("Accounting Supervisor approves the request", async () => {
  await page.login(adminEmail, PASSWORD);
  await page.goto("/users/requests");
  await page.follow('main td.actions a[href^="/users/requests/"]');
  await page.submit('form[action$="/decision"]', 'button[name="action"][value="approve"]');
  await expectSuccess("approve request");
  await signOut();
});
await step("accounting staff sign in and record an expense for approval", async () => {
  await page.login("liza@johnvivz.local", PASSWORD);
  expect((await page.text()).includes("Your accounting workspace"), "no accounting dashboard");
  await page.goto("/accounting/expenses");
  const f = 'form[action="/accounting/expenses"][method="POST"]';
  await page.set("category_id", "Supplies", f);
  await page.set("txn_date", workdays[1], f);
  await page.set("amount", "850", f);
  await page.set("payment_method", "cash", f);
  await page.set("description", "Printer ink", f);
  await page.submit(f);
  await expectSuccess("expense");
  await page.goto("/dashboard");
  expect((await page.text()).includes("Printer ink"), "the entry is not listed as waiting");
  await signOut();
});

// ---- Employee, on a phone: Login → Dashboard → ... → Enroll Bank Account → Monitor Requests
await page.viewport(390, 844, true);
await step("Employee signs in on a phone", async () => {
  await firstSignIn("maria@johnvivz.local", temp.maria);
  expect((await page.text()).includes("Hi, Maria"), "no greeting");
});
await step("the phone field formats itself while typing", async () => {
  await page.goto("/my/profile");
  await page.set("phone", "09171234567");
  expect((await page.value('[name="phone"]')) === "0917 123 4567", `phone became ${await page.value('[name="phone"]')}`);
});
await step("Employee enrolls a bank account", async () => {
  await page.goto("/my/bank");
  await page.follow('main a[href*="new=1"]'); // the "Enroll bank account" button
  const f = 'form[action="/my/bank/requests"]';
  await page.set("bank_name", "LANDBANK", f);
  await page.set("account_type", "savings", f);
  await page.set("account_holder_name", "Maria Dela Cruz", f);
  await page.set("account_number", "1234-5678-90", f);
  expect((await page.value('[name="account_number"]')) === "1234567890", "account number mask");
  await page.set("account_number_confirm", "1234567890", f);
  await page.submit(f);
  await expectSuccess("bank enrollment");
});
await step("Employee applies for leave", async () => {
  await page.goto("/my/leave");
  const f = 'form[action="/my/leave/applications"]';
  await page.set("leave_type_id", "Vacation", f);
  await page.set("start_date", iso(nextMonday), f);
  await page.set("end_date", iso(tuesday), f);
  await page.set("reason", "Family trip to Calapan", f);
  await page.submit(f);
  await expectSuccess("leave");
});
await step("Employee requests an attendance correction", async () => {
  await page.goto("/my/attendance");
  await page.follow('main a[href*="#correction"]'); // the "Request correction" button
  const f = 'form[action="/my/attendance/corrections"]';
  await page.set("work_date", workdays[0], f);
  await page.set("requested_status", "present", f);
  await page.set("requested_time_in", "08:00", f);
  await page.set("requested_time_out", "17:00", f);
  await page.set("reason", "Forgot to time in at the front gate", f);
  await page.submit(f);
  await expectSuccess("correction");
});
await step("Employee sees the three pending requests", async () => {
  await page.goto("/dashboard");
  expect(/Leave 1\s*·\s*Attendance 1\s*·\s*Bank 1/.test(await page.text()), "pending counts on the dashboard");
});
await step("the navigation drawer opens and closes on the phone", async () => {
  await page.goto("/my/payslips");
  await page.ev(`document.querySelector("[data-drawer-open]").click()`);
  await new Promise((r) => setTimeout(r, 400)); // slide-in transition
  expect(await page.ev(`document.getElementById("sidebar").getBoundingClientRect().left >= 0`), "the drawer did not slide in");
  expect(await page.ev(`!!document.querySelector('.sidebar a[href="/my/payslips"]').offsetParent`), "My Payslips is not visible in the drawer");
  await page.ev(`document.querySelector(".scrim").click()`);
  expect(!(await page.ev(`document.body.classList.contains("drawer-open")`)), "the drawer did not close");
});
await step("nothing overflows sideways on the phone", async () => {
  expect(await page.ev("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), "horizontal overflow");
});
await page.viewport(1440, 900, false);
await step("Employee signs out", signOut);

// ---- Accounting Supervisor: Login → Dashboard → Pending Approvals → Review → Approve
await step("Accounting Supervisor signs in", () => firstSignIn("grace@johnvivz.local", temp.grace));
await step("Supervisor approves the bank enrollment", async () => {
  await page.goto("/bank-enrollments");
  await page.follow('main td.actions a[href^="/bank-enrollments/"]');
  await page.submit('form[action$="/decision"]', 'button[name="action"][value="approve"]');
  await expectSuccess("bank enrollment");
});
// two-step approval: Maria has no supervisor on record, so the Accounting Supervisor gives the first approval of her
// leave and attendance correction under Team Approvals; Payroll Staff give the final approval below
await step("Supervisor gives the first approval under Team Approvals", async () => {
  await page.goto("/team/approvals");
  for (let i = 0; i < 4 && await page.has('form[action^="/team/approvals/"]'); i++) {
    await page.submit('form[action^="/team/approvals/"]', 'button[name="action"][value="approve"]');
  }
  expect(!(await page.has('form[action^="/team/approvals/"]')), "first approvals left");
});
const finalApprovals = [
  ["leave application", "/leave-requests", 'a[href^="/leave-requests/"]'],
  ["attendance correction", "/attendance/corrections", 'a[href^="/attendance/corrections/"]'],
];
for (const [label, list, link] of []) {
  await step(`Supervisor approves the ${label}`, async () => {
    await page.goto(list);
    await page.follow(`main td.actions ${link}`);
    await page.submit('form[action$="/decision"]', 'button[name="action"][value="approve"]');
    await expectSuccess(label);
  });
}
await step("Supervisor verifies starting salaries", async () => {
  await page.goto("/payroll/salary-changes");
  for (let i = 0; i < 6 && await page.has('form[action$="/decision"]'); i++) {
    await page.submit('form[action$="/decision"]', 'button[name="action"][value="approve"]');
  }
  expect(!(await page.has('form[action$="/decision"]')), "salary changes left");
});
await step("Supervisor signs out", signOut);

// ---- Payroll Staff: Login → Attendance Validation → Payroll Preparation → Computation → Submit
let batchPath;
await step("Payroll Staff signs in", () => firstSignIn("paolo@johnvivz.local", temp.paolo));
for (const [label, list, link] of finalApprovals) {
  await step(`Payroll Staff give the final approval of the ${label}`, async () => {
    await page.goto(list);
    await page.follow(`main td.actions ${link}`);
    await page.submit('form[action$="/decision"]', 'button[name="action"][value="approve"]');
    await expectSuccess(label);
  });
}
for (const day of workdays) {
  await step(`Staff encodes attendance for ${day}`, async () => {
    await page.goto(`/attendance/encode?date=${day}`);
    expect((await page.value('input[name="date"]')) === day, `the form holds ${await page.value('input[name="date"]')}`);
    await page.ev(`(() => { for (const row of document.querySelectorAll('select[name$="[status]"]')) {
      if (row.getAttribute("aria-label").includes("Reyes") || row.disabled) continue;
      row.value = "present";
      const key = row.name.slice(0, -"[status]".length);
      document.querySelector('[name="' + key + '[time_in]"]').value = "08:00";
      document.querySelector('[name="' + key + '[time_out]"]').value = "17:00";
    } })()`);
    await page.submit('form[action="/attendance/encode"][method="POST"]');
    await expectSuccess("attendance");
  });
}
await step("Staff validates the attendance", async () => {
  await page.goto(`/attendance/validation?from=${workdays[0]}&to=${workdays[2]}`);
  await page.tick("[data-check-all]");
  await page.submit('form[action="/attendance/validation"][method="POST"]');
  await expectSuccess("validation");
});
// periods are the supervisor's: last month's kinsenas and katapusan on the fixed dates (the supervisor's own journey
// covers the form; here the schedule creates them as it does for the current and next month)
const { createFixedMonth } = await import(new URL("../../services/payrollScheduleService.js", import.meta.url).href);
await createFixedMonth({ user: { id: null, role_code: "system", full_name: "Test schedule", can: () => true }, ip: null, get: () => null }, ym);
const kinsenas = await db.selectOne("SELECT id FROM payroll_periods WHERE pay_frequency = 'semi_monthly' AND start_date = ?", [`${ym}-01`]);
await step("Staff open the Payroll tab and compute last month's kinsenas", async () => {
  await page.goto("/payroll");
  expect((await page.text()).includes("kinsenas"), "the fixed periods are not listed");
  await page.submit(`form[action="/payroll/periods/${kinsenas.id}/compute"]`);
  batchPath = await page.url();
  expect(/\/payroll\/batches\/\d+/.test(batchPath), `no batch page: ${batchPath}. ${(await page.messages()).join(" | ")}`);
  expect((await page.text()).includes("Maria"), "Maria is not in the batch");
});
await step("Staff submits the batch for approval", async () => {
  await page.submit('form[action$="/submit"]');
  await expectSuccess("submit");
  expect(!(await page.has('form[action$="/approve"]')), "staff was offered Approve");
});
await step("Staff signs out", signOut);

// ---- Supervisor: approval through release
await step("Supervisor approves, finalizes and releases the batch", async () => {
  await page.login("grace@johnvivz.local", PASSWORD);
  await page.goto("/dashboard");
  expect((await page.text()).includes("Pending approvals"), "no approvals panel");
  await page.goto(batchPath);
  if (await page.has('[name="acknowledge_own"]')) await page.tick('[name="acknowledge_own"]');
  await page.submit('form[action$="/approve"]');
  await expectSuccess("approve");
  await page.submit('form[action$="/finalize"]');
  await expectSuccess("finalize");
  await page.submit('form[action$="/release"]');
  await expectSuccess("release");
  expect((await page.text()).includes("Released"), "status is not Released");
});
await step("Supervisor signs out", signOut);

// ---- Employee: the payslip arrives
await step("Employee opens the payslip and its PDF", async () => {
  await page.login("maria@johnvivz.local", PASSWORD);
  await page.goto("/my/payslips");
  await page.follow('main a[href^="/my/payslips/"]');
  const slip = await page.text();
  expect(slip.includes("Net pay") || slip.includes("NET PAY"), "no net pay");
  const pdf = await page.ev(`fetch(location.pathname + "/pdf").then((r) => r.status + " " + r.headers.get("content-type"))`, true);
  expect(pdf.startsWith("200 application/pdf"), pdf);
});
await step("Employee was notified", async () => {
  await page.goto("/notifications");
  const text = await page.text();
  for (const s of ["payslip", "leave", "bank", "correction"]) expect(text.toLowerCase().includes(s), `no ${s} notification`);
});
await step("Employee signs out again", signOut);

// ---- Accounting Supervisor: Accounting → Analytics → Reports → System Settings
await step("Accounting Supervisor records income", async () => {
  await page.login(adminEmail, PASSWORD);
  await page.goto("/accounting/income");
  const f = 'form[action="/accounting/income"][method="POST"]';
  await page.set("category_id", "Sales Revenue", f);
  await page.set("txn_date", workdays[1], f);
  await page.set("amount", "50000", f);
  await page.set("payment_method", "cash", f);
  await page.set("description", "Store sales", f);
  await page.submit(f);
  await expectSuccess("income");
});
await step("table tools search, filter and sort a list", async () => {
  await page.goto("/accounting/accounts");
  const visible = () => page.ev(`[...document.querySelectorAll("table[data-table-tools] tbody tr")].filter((r) => !r.hidden).length`);
  const total = await page.ev(`document.querySelectorAll("table[data-table-tools] tbody tr").length`);
  expect(total > 10, `only ${total} accounts`);
  expect((await visible()) === 10, `first page shows ${await visible()}`);
  await page.ev(`(() => { const s = document.querySelector(".table-tools input[type=search]"); s.value = "Retirement"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const hits = await visible();
  expect(hits > 0 && hits < 10, `search left ${hits} rows`);
  expect(await page.ev(`[...document.querySelectorAll("table[data-table-tools] tbody tr")].filter((r) => !r.hidden).every((r) => r.textContent.includes("Retirement"))`), "search matched the wrong rows");
  await page.ev(`(() => { const s = document.querySelector(".table-tools input[type=search]"); s.value = "zzzz"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  expect((await visible()) === 0 && (await page.text()).includes("No matching records"), "no empty message");
});
await step("Analytics draws its charts and filters by year", async () => {
  await page.goto(`/analytics?year=${y}`);
  expect((await page.value('[name="year"]')) === String(y), "year not kept");
  expect((await page.ev("document.querySelectorAll('canvas').length")) >= 5, "charts missing");
  expect((await page.text()).includes("Operating expenses by account"), "no pie chart");
});
await step("payroll cost matches the books even with absences", async () => {
  const absences = Number((await db.selectOne("SELECT COALESCE(SUM(d.amount), 0) AS n FROM payroll_deductions d JOIN salary_components c ON c.id = d.component_id WHERE c.category = 'absence'")).n);
  expect(absences > 0, "this payroll was expected to include absences");
  const books = Number((await db.selectOne("SELECT COALESCE(SUM(l.debit - l.credit), 0) AS n FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.code IN ('5010', '5020', '5030', '5060')")).n);
  const amount = "₱" + books.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await page.goto(`/analytics?year=${y}`);
  expect((await page.text()).includes(amount), `analytics does not show ${amount}`);
  await page.goto(`/reports/payroll-expense?from=${ym}-01&to=${ym}-15`);
  expect((await page.text()).includes(amount), `the expense report does not show ${amount}`);
});
await step("a report exports to PDF and Excel", async () => {
  await page.goto("/reports/payroll-register");
  const links = await page.ev(`[...document.querySelectorAll('a[href*="/export"]')].map((a) => a.getAttribute("href"))`);
  expect(links.length >= 2, `export links: ${links}`);
  for (const link of links) {
    const status = await page.ev(`fetch(${JSON.stringify(link)}).then((r) => r.status)`, true);
    expect(status === 200, `${link} → ${status}`);
  }
});
await step("settings and the privacy notice open", async () => {
  await page.goto("/settings");
  expect((await page.text()).includes("How monthly contributions are deducted"), "settings");
  await page.goto("/privacy");
  expect((await page.text()).includes("Data Privacy Act"), "privacy notice");
});

await step("inactivity: a warning first, then an automatic sign-out", async () => {
  await page.goto("/dashboard");
  const idle = Number(await page.ev("document.querySelector('[data-session]').dataset.idleMs"));
  await page.ev(`localStorage.setItem("jvzpay-session-activity", String(Date.now() - ${idle} + 60000))`);
  let open = false;
  for (let i = 0; i < 40 && !open; i++) { await new Promise((r) => setTimeout(r, 100)); open = await page.ev("document.getElementById('session-dialog').open"); }
  expect(open, "no warning shown a minute before the sign-out");
  await page.ev("document.querySelector('[data-session-stay]').click()");
  let closed = false;
  for (let i = 0; i < 40 && !closed; i++) { await new Promise((r) => setTimeout(r, 100)); closed = !(await page.ev("document.getElementById('session-dialog').open")); }
  expect(closed, "Stay signed in did not close the warning");
  await page.ev(`localStorage.setItem("jvzpay-session-activity", String(Date.now() - ${idle} - 1000))`);
  let url = "";
  for (let i = 0; i < 60 && !url.startsWith("/login"); i++) { await new Promise((r) => setTimeout(r, 100)); url = await page.url().catch(() => ""); }
  expect(url.startsWith("/login?expired=1"), `not signed out: ${url}`);
  await new Promise((r) => setTimeout(r, 300));
  expect((await page.text()).includes("minutes without activity"), "no explanation on the sign-in page");
});
check("no console, script or content-security errors on any page", page.problems.length === 0, page.problems.slice(0, 5).join(" || "));
await page.close();
report();
await db.sequelize.close();
process.exit(0);
