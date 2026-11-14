// Payroll computation tests. Every expected figure below was calculated by hand from the documented method.
// Calendar used: November 2026 — the 1st, 8th, 15th, 22nd and 29th are Sundays (the default rest day),
// so 1–15 Nov has 12 scheduled days: Mon 2 – Sat 7 and Mon 9 – Sat 14.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEmployeePayroll, contribution, annualTax, toC, fromC, PayrollConfigError } from "../services/payrollEngine.js";

const settings = {
  days_per_year: 313, hours_per_day: 8, rest_day: 0, contribution_schedule: "split",
  ot_multiplier_regular: 1.25, ot_multiplier_rest_day: 1.69, ot_multiplier_holiday: 2.6,
  holiday_multiplier_regular: 2, holiday_multiplier_special: 1.3, night_diff_rate: 0.1,
};
const rules = {
  SSS: { id: 1, employee_rate: "0.05", employer_rate: "0.10", salary_floor: "5000", salary_ceiling: "35000", rounding_step: "500", ec_threshold: "15000", ec_amount_low: "10", ec_amount_high: "30" },
  PHILHEALTH: { id: 2, employee_rate: "0.025", employer_rate: "0.025", salary_floor: "10000", salary_ceiling: "100000", rounding_step: "0", ec_threshold: "0", ec_amount_low: "0", ec_amount_high: "0" },
  PAGIBIG: { id: 3, employee_rate: "0.02", employer_rate: "0.02", salary_floor: "0", salary_ceiling: "10000", rounding_step: "0", ec_threshold: "0", ec_amount_low: "0", ec_amount_high: "0" },
};
const brackets = [
  { annual_from: "0", annual_to: "250000", base_tax: "0", rate: "0" },
  { annual_from: "250000", annual_to: "400000", base_tax: "0", rate: "0.15" },
  { annual_from: "400000", annual_to: "800000", base_tax: "22500", rate: "0.20" },
  { annual_from: "800000", annual_to: "2000000", base_tax: "102500", rate: "0.25" },
  { annual_from: "2000000", annual_to: "8000000", base_tax: "402500", rate: "0.30" },
  { annual_from: "8000000", annual_to: null, base_tax: "2202500", rate: "0.35" },
];
const WORKDAYS = ["02", "03", "04", "05", "06", "07", "09", "10", "11", "12", "13", "14"].map((d) => `2026-11-${d}`);
const present = (date, extra = {}) => ({ work_date: date, status: "present", validation_status: "validated", hours_worked: "8.00", late_minutes: 0, undertime_minutes: 0, time_in: "08:00:00", time_out: "17:00:00", ...extra });
const fullAttendance = (except = []) => WORKDAYS.filter((d) => !except.includes(d)).map((d) => present(d));
const first = { start_date: "2026-11-01", end_date: "2026-11-15", pay_frequency: "semi_monthly" };
const second = { start_date: "2026-11-16", end_date: "2026-11-30", pay_frequency: "semi_monthly" };
const emp = (o = {}) => ({ basic_salary: "18000", rate_basis: "monthly", is_mwe: 0, date_hired: "2024-01-01", date_separated: null, ...o });
const run = (o = {}) => computeEmployeePayroll({ employee: emp(o.emp), period: o.period || first, settings: { ...settings, ...o.settings }, attendance: o.attendance ?? fullAttendance(), holidays: o.holidays || [], leaves: o.leaves || [], overtime: o.overtime || [], payItems: o.payItems || [], adjustments: o.adjustments || [], rules, brackets });
const line = (list, re) => list.find((l) => re.test(l.description));

test("money helpers round-trip", () => {
  assert.equal(toC("1234.56"), 123456);
  assert.equal(fromC(123456), "1234.56");
  assert.equal(fromC(-5), "-0.05");
});

test("SSS: salary credit rounds to the nearest 500, with floor, ceiling and EC split", () => {
  assert.deepEqual(contribution(rules.SSS, toC("18000")), { base: 1800000, ee: 90000, er: 180000, ec: 3000 });
  assert.equal(contribution(rules.SSS, toC("15249.99")).base, 1500000);
  assert.equal(contribution(rules.SSS, toC("15250")).base, 1550000);
  assert.deepEqual(contribution(rules.SSS, toC("3000")), { base: 500000, ee: 25000, er: 50000, ec: 1000 });
  assert.deepEqual(contribution(rules.SSS, toC("50000")), { base: 3500000, ee: 175000, er: 350000, ec: 3000 });
});

test("PhilHealth: 2.5% each with income floor and ceiling", () => {
  assert.equal(contribution(rules.PHILHEALTH, toC("8000")).ee, 25000);
  assert.equal(contribution(rules.PHILHEALTH, toC("18000")).ee, 45000);
  assert.equal(contribution(rules.PHILHEALTH, toC("150000")).er, 250000);
});

test("Pag-IBIG: 2% each capped at the maximum fund salary", () => {
  assert.equal(contribution(rules.PAGIBIG, toC("18000")).ee, 20000);
  assert.equal(contribution(rules.PAGIBIG, toC("5000")).er, 10000);
});

test("annual tax table boundaries", () => {
  const t = (n) => annualTax(brackets, toC(n)) / 100;
  assert.equal(t("250000"), 0);
  assert.equal(t("300000"), 7500);
  assert.equal(t("400000"), 22500);
  assert.equal(t("500000"), 42500);
  assert.equal(t("800000"), 102500);
  assert.equal(t("9000000"), 2552500);
});

test("monthly-rated, full attendance, first half of the month", () => {
  const { record: r, contributions } = run();
  assert.equal(r.basic_pay, "9000.00");
  assert.equal(r.gross_pay, "9000.00");
  // SSS 900/2 + PhilHealth 450/2 + Pag-IBIG 200/2
  assert.equal(r.statutory_employee, "775.00");
  assert.equal(r.withholding_tax, "0.00", "8,225 × 24 = 197,400 is below 250,000");
  assert.equal(r.net_pay, "8225.00");
  // employer: SSS 1,800/2 + EC 30/2 + PhilHealth 225 + Pag-IBIG 100
  assert.equal(r.employer_contributions, "1240.00");
  assert.equal(contributions.length, 3);
  assert.equal(r.days_worked, 12);
});

test("split contributions: odd centavos go to the second half so the month adds up exactly", () => {
  const oddRules = { ...rules, PAGIBIG: { ...rules.PAGIBIG, employee_rate: "0.020001" } }; // monthly 200.01
  const base = { employee: emp(), settings, holidays: [], leaves: [], overtime: [], payItems: [], adjustments: [], brackets, rules: oddRules };
  const a = computeEmployeePayroll({ ...base, period: first, attendance: fullAttendance() });
  const b = computeEmployeePayroll({ ...base, period: second, attendance: ["16","17","18","19","20","21","23","24","25","26","27","28","30"].map((d) => present(`2026-11-${d}`)) });
  const pi = (x) => toC(x.contributions.find((c) => c.agency === "PAGIBIG").employee_share);
  assert.equal(pi(a) + pi(b), 20001);
});

test("'last' schedule deducts the whole month only in the last period", () => {
  const a = run({ settings: { contribution_schedule: "last" } });
  assert.equal(a.record.statutory_employee, "0.00");
  const b = run({ period: second, settings: { contribution_schedule: "last" }, attendance: ["16","17","18","19","20","21","23","24","25","26","27","28","30"].map((d) => present(`2026-11-${d}`)) });
  assert.equal(b.record.statutory_employee, "1550.00");
});

test("monthly period: full basic and full contributions", () => {
  const days = []; for (let d = 2; d <= 30; d++) { const s = String(d).padStart(2, "0"); if (![8, 15, 22, 29].includes(d)) days.push(present(`2026-11-${s}`)); }
  const { record: r } = run({ period: { start_date: "2026-11-01", end_date: "2026-11-30", pay_frequency: "monthly" }, attendance: days });
  assert.equal(r.basic_pay, "18000.00");
  assert.equal(r.statutory_employee, "1550.00");
});

test("monthly-rated: absences and lateness are deducted at the daily and hourly rate", () => {
  const att = fullAttendance(["2026-11-03"]).map((a) => (a.work_date === "2026-11-04" ? { ...a, status: "late", late_minutes: 30 } : a));
  att.push({ work_date: "2026-11-03", status: "absent", validation_status: "validated", hours_worked: "0", late_minutes: 0, undertime_minutes: 0 });
  const { record: r, deductions } = run({ attendance: att });
  // daily = 18,000 × 12 ÷ 313 = 690.0958…; hourly = 86.2620…; 30 min = 43.13
  assert.equal(line(deductions, /^Absences/).amount, "690.10");
  assert.equal(line(deductions, /^Late/).amount, "43.13");
  assert.equal(r.other_deductions, "733.23");
  assert.equal(r.basic_pay, "9000.00");
  assert.equal(r.net_pay, "7491.77"); // 9,000 − 733.23 − 775
  assert.equal(r.days_absent, 1);
});

test("daily-rated with paid leave, lateness and approved overtime", () => {
  const att = fullAttendance(["2026-11-03", "2026-11-04"]).map((a) => (a.work_date === "2026-11-05" ? { ...a, status: "late", late_minutes: 25 } : a));
  att.push({ work_date: "2026-11-03", status: "absent", validation_status: "validated", hours_worked: "0", late_minutes: 0, undertime_minutes: 0 });
  att.push({ work_date: "2026-11-04", status: "on_leave", validation_status: "validated", hours_worked: "0", late_minutes: 0, undertime_minutes: 0 });
  const { record: r, contributions } = run({
    emp: { basic_salary: "560", rate_basis: "daily" }, attendance: att,
    leaves: [{ start_date: "2026-11-04", end_date: "2026-11-04", days: "1.0", is_paid: 1, code: "VL" }],
    overtime: [{ id: 7, work_date: "2026-11-06", hours: "2.5", ot_type: "regular" }],
  });
  assert.equal(r.days_worked, 11, "10 worked + 1 paid leave");
  assert.equal(r.basic_pay, "6160.00");
  assert.equal(r.overtime_pay, "218.75"); // 2.5 × 70 × 1.25
  assert.equal(r.gross_pay, "6378.75");
  assert.equal(r.other_deductions, "29.17"); // 25 min at 70/h
  // monthly-equivalent 14,606.67: SSS credit 14,500 → 725/2; PhilHealth 365.17 → floor(36517/2)=182.58; Pag-IBIG 100
  assert.equal(r.statutory_employee, "645.08");
  assert.equal(contributions.find((c) => c.agency === "SSS").ec_share, "5.00", "EC ₱10 monthly below the ₱15,000 threshold");
  assert.equal(r.net_pay, "5704.50");
});

test("hourly-rated is paid for hours worked", () => {
  const att = fullAttendance().slice(0, 5);
  const { record: r } = run({ emp: { basic_salary: "75", rate_basis: "hourly" }, attendance: att });
  assert.equal(r.basic_pay, "3000.00"); // 40 h × 75
});

test("withholding tax uses the annualised method after contributions", () => {
  const { record: r } = run({ emp: { basic_salary: "60000" } });
  assert.equal(r.statutory_employee, "1725.00"); // SSS 875 + PhilHealth 750 + Pag-IBIG 100
  // (30,000 − 1,725) × 24 = 678,600 → 22,500 + 20% × 278,600 = 78,220 ÷ 24
  assert.equal(r.withholding_tax, "3259.17");
  assert.equal(r.net_pay, "25015.83");
});

test("minimum wage earners are exempt from withholding tax", () => {
  assert.equal(run({ emp: { basic_salary: "60000", is_mwe: 1 } }).record.withholding_tax, "0.00");
});

test("mid-period hire is pro-rated by scheduled days", () => {
  const { record: r, notes } = run({ emp: { date_hired: "2026-11-09" }, attendance: fullAttendance().slice(6) });
  assert.equal(r.basic_pay, "4500.00"); // 6 of 12 days
  assert.ok(notes.some((n) => /Pro-rated/.test(n)));
});

test("regular holiday: daily-rated paid when unworked, 200% when worked; monthly-rated gets only the premium", () => {
  const holidays = [{ holiday_date: "2026-11-05", name: "Test Holiday", holiday_type: "regular" }];
  const att = fullAttendance(["2026-11-05"]);
  const off = run({ emp: { basic_salary: "560", rate_basis: "daily" }, holidays, attendance: att });
  assert.equal(off.record.days_worked, 11);
  assert.equal(off.record.holiday_pay, "560.00");
  const worked = [...att, present("2026-11-05", { status: "holiday" })];
  assert.equal(run({ emp: { basic_salary: "560", rate_basis: "daily" }, holidays, attendance: worked }).record.holiday_pay, "1120.00");
  // monthly: hourly 86.2620 × 8 h × 100% premium; no deduction for the unworked holiday
  assert.equal(run({ holidays, attendance: worked }).record.holiday_pay, "690.10");
  const mOff = run({ holidays, attendance: att }).record;
  assert.equal(mOff.holiday_pay, "0.00");
  assert.equal(mOff.other_deductions, "0.00");
});

test("special non-working day: no work, no pay for daily-rated; 130% when worked", () => {
  const holidays = [{ holiday_date: "2026-11-05", name: "Special Day", holiday_type: "special_non_working" }];
  const att = fullAttendance(["2026-11-05"]);
  const e = { basic_salary: "560", rate_basis: "daily" };
  assert.equal(run({ emp: e, holidays, attendance: att }).record.holiday_pay, "0.00");
  assert.equal(run({ emp: e, holidays, attendance: [...att, present("2026-11-05", { status: "holiday" })] }).record.holiday_pay, "728.00");
});

test("overtime multipliers by type", () => {
  const ot = (t) => run({ emp: { basic_salary: "560", rate_basis: "daily" }, overtime: [{ id: 1, work_date: "2026-11-06", hours: "2", ot_type: t }] }).record.overtime_pay;
  assert.equal(ot("regular"), "175.00");
  assert.equal(ot("rest_day"), "236.60");
  assert.equal(ot("holiday"), "364.00");
});

test("night differential on minutes worked after 22:00", () => {
  const att = fullAttendance().map((a, i) => (i === 0 ? { ...a, time_in: "14:00:00", time_out: "23:00:00" } : a));
  assert.equal(run({ emp: { basic_salary: "560", rate_basis: "daily" }, attendance: att }).record.night_diff_pay, "7.00"); // 1 h × 70 × 10%
});

test("leave without pay counts as an absence; half-day paid leave pays the full day", () => {
  const lwop = fullAttendance(["2026-11-03"]);
  lwop.push({ work_date: "2026-11-03", status: "on_leave", validation_status: "validated", hours_worked: "0", late_minutes: 0, undertime_minutes: 0 });
  const a = run({ emp: { basic_salary: "560", rate_basis: "daily" }, attendance: lwop, leaves: [{ start_date: "2026-11-03", end_date: "2026-11-03", days: "1.0", is_paid: 0, code: "LWOP" }] }).record;
  assert.deepEqual([a.days_worked, a.days_absent], [11, 1]);
  const half = fullAttendance(["2026-11-03"]);
  half.push(present("2026-11-03", { status: "half_day", hours_worked: "4.00", time_out: "12:00:00" }));
  const b = run({ emp: { basic_salary: "560", rate_basis: "daily" }, attendance: half, leaves: [{ start_date: "2026-11-03", end_date: "2026-11-03", days: "0.5", is_paid: 1, code: "VL" }] }).record;
  assert.deepEqual([b.days_worked, b.days_absent, b.basic_pay], [12, 0, "6720.00"]);
});

test("missing or pending attendance is never paid and always warned about", () => {
  const att = fullAttendance(["2026-11-03", "2026-11-04"]);
  att.push(present("2026-11-04", { validation_status: "pending" }));
  const { record: r, warnings } = run({ emp: { basic_salary: "560", rate_basis: "daily" }, attendance: att });
  assert.equal(r.days_worked, 10);
  assert.ok(warnings.some((w) => /2 scheduled day/.test(w)));
  assert.ok(warnings.some((w) => /pending validation/.test(w)));
});

test("allowances: non-taxable amounts stay out of the tax base; loans stop at the remaining balance", () => {
  const items = [
    { id: 1, component_type: "earning", category: "allowance", component_code: "RICE", component_name: "Rice", is_taxable: 0, amount: "1000", description: "Rice subsidy" },
    { id: 2, component_type: "deduction", category: "loan", component_code: "LOAN", component_name: "Loan", amount: "500", remaining_balance: "300.50", description: "Salary advance" },
  ];
  const { record: r, deductions } = run({ emp: { basic_salary: "60000" }, payItems: items });
  assert.equal(r.allowances, "1000.00");
  assert.equal(r.gross_pay, "31000.00");
  assert.equal(r.withholding_tax, "3259.17", "same tax as without the non-taxable allowance");
  assert.equal(line(deductions, /Salary advance/).amount, "300.50");
  assert.equal(r.net_pay, "25715.33"); // 31,000 − 1,725 − 3,259.17 − 300.50
});

test("approved adjustments flow into earnings and deductions", () => {
  const adj = [
    { id: 1, adjustment_no: "PADJ-1", adjustment_type: "earning", component_code: "OTHER_EARN", is_taxable: 1, amount: "250", reason: "Underpaid last period" },
    { id: 2, adjustment_no: "PADJ-2", adjustment_type: "deduction", component_code: "OTHER_DED", amount: "100", reason: "Uniform" },
  ];
  const { record: r } = run({ adjustments: adj });
  assert.equal(r.other_earnings, "250.00");
  assert.equal(r.other_deductions, "100.00");
  assert.equal(r.net_pay, "8375.00");
});

test("net pay can never go negative: loans are reduced first", () => {
  const items = [{ id: 9, component_type: "deduction", category: "loan", component_code: "LOAN", component_name: "Loan", amount: "20000", remaining_balance: "20000", description: "Big loan" }];
  const { record: r, warnings } = run({ payItems: items });
  assert.equal(r.net_pay, "0.00");
  assert.equal(r.other_deductions, "8225.00");
  assert.ok(warnings.some((w) => /reduced/.test(w)));
});

test("no attendance at all: no pay, no contributions, no negative net", () => {
  const { record: r, notes } = run({ attendance: [] });
  assert.equal(r.basic_pay, "9000.00");
  assert.equal(r.other_deductions, "9000.00", "absences are capped at basic pay");
  assert.equal(r.statutory_employee, "0.00");
  assert.equal(r.net_pay, "0.00");
  assert.ok(notes.some((n) => /No compensation/.test(n)));
});

test("record totals always satisfy the database arithmetic constraints", () => {
  const { record: r } = run({ overtime: [{ id: 1, work_date: "2026-11-06", hours: "1.75", ot_type: "regular" }], emp: { basic_salary: "33333.33" } });
  const c = toC;
  assert.equal(c(r.gross_pay), c(r.basic_pay) + c(r.overtime_pay) + c(r.holiday_pay) + c(r.night_diff_pay) + c(r.allowances) + c(r.other_earnings));
  assert.equal(c(r.total_deductions), c(r.statutory_employee) + c(r.withholding_tax) + c(r.other_deductions));
  assert.equal(c(r.net_pay), c(r.gross_pay) - c(r.total_deductions));
});

test("a missing statutory rule is a clear configuration error", () => {
  assert.throws(() => computeEmployeePayroll({ employee: emp(), period: first, settings, attendance: fullAttendance(), holidays: [], leaves: [], overtime: [], payItems: [], adjustments: [], rules: { SSS: rules.SSS }, brackets }), PayrollConfigError);
});
