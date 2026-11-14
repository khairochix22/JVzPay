// Time clock, vacation leave conversion and retirement fund: the pure rules, figures worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPunches, computeFromPunches } from "../services/timeClockService.js";
import { tenureYears, withdrawalSplit } from "../services/retirementService.js";
import { conversionYear } from "../services/leaveConversionService.js";
import { checkPlottedDay } from "../services/scheduleHandlers.js";
import { checkBenefit } from "../services/enrollmentService.js";
import { loanQuote, serviceMonths } from "../services/salaryLoanService.js";
import { fixedHalf, releaseDateFor } from "../services/payrollScheduleService.js";
import { computeEmployeePayroll } from "../services/payrollEngine.js";

const sched = { shift_start: "08:00", am_break_start: "10:00", am_break_end: "10:15", lunch_start: "12:00", lunch_end: "13:00", pm_break_start: "15:00", pm_break_end: "15:15", shift_end: "17:00" };
const cfg = { grace: 10, shortBreak: 15, hoursPerDay: 8 };

test("time clock: only the next step can be punched, breaks must be closed before going on", () => {
  assert.deepEqual(nextPunches(new Set()), ["am_in", "pm_in"]);
  assert.deepEqual(nextPunches(new Set(["am_in"])), ["am_break_start", "am_out"]);
  assert.deepEqual(nextPunches(new Set(["am_in", "am_break_start"])), ["am_break_end"]);
  assert.deepEqual(nextPunches(new Set(["am_in", "am_break_start", "am_break_end"])), ["am_out"]);
  assert.deepEqual(nextPunches(new Set(["am_in", "am_out"])), ["pm_in"]);
  assert.deepEqual(nextPunches(new Set(["am_in", "am_out", "pm_in"])), ["pm_break_start", "pm_out"]);
  assert.deepEqual(nextPunches(new Set(["am_in", "am_out", "pm_in", "pm_out"])), []);
  assert.deepEqual(nextPunches(new Set(["pm_in"])), ["pm_break_start", "pm_out"], "afternoon-only half day");
});

test("time clock: a day on the plotted times is 8 paid hours with nothing lost", () => {
  const d = computeFromPunches({ am_in: "07:58", am_break_start: "10:00", am_break_end: "10:15", am_out: "12:00", pm_in: "13:00", pm_break_start: "15:00", pm_break_end: "15:15", pm_out: "17:00" }, sched, cfg);
  assert.equal(d.status, "present");
  assert.equal(d.hours_worked, 8, "breaks are paid, lunch is not");
  assert.equal(d.late_minutes, 0);
  assert.equal(d.undertime_minutes, 0);
  assert.equal(d.overbreak_minutes, 0);
  assert.equal(d.remarks, null);
});

test("time clock: every minute past a break or lunch is lost time", () => {
  // morning break 10:00–10:25 (10 over), lunch 12:00–13:20 (forgot to punch back in on time: 20 over),
  // afternoon break started late 15:10 and back 15:28: 18 minutes long (3 over) but 13 past the plotted 15:15 → 13
  const d = computeFromPunches({ am_in: "08:00", am_break_start: "10:00", am_break_end: "10:25", am_out: "12:00", pm_in: "13:20", pm_break_start: "15:10", pm_break_end: "15:28", pm_out: "17:00" }, sched, cfg);
  assert.deepEqual(d.lost, { am_break: 10, lunch: 20, pm_break: 13 });
  assert.equal(d.overbreak_minutes, 43);
  assert.equal(d.late_minutes, 0, "coming back late from lunch is lost time, not lateness");
  assert.equal(d.status, "present");
  // worked 240 + 220 − 10 − 13 = 437 min
  assert.equal(d.hours_worked, 7.28);
});

test("time clock: a break taken early is fine if it lasts 15 minutes; a long one is not", () => {
  assert.equal(computeFromPunches({ am_in: "08:00", am_break_start: "09:30", am_break_end: "09:45", am_out: "12:00" }, sched, cfg).overbreak_minutes, 0);
  assert.equal(computeFromPunches({ am_in: "08:00", am_break_start: "09:30", am_break_end: "09:52", am_out: "12:00" }, sched, cfg).overbreak_minutes, 7);
});

test("time clock: late arrival and leaving early; unpunched breaks are noted", () => {
  const d = computeFromPunches({ am_in: "08:20", am_out: "12:00", pm_in: "13:00", pm_out: "16:30" }, sched, cfg);
  assert.equal(d.late_minutes, 20);
  assert.equal(d.undertime_minutes, 30);
  assert.equal(d.status, "late");
  assert.equal(d.remarks, "Not punched: morning break, afternoon break");
  assert.equal(computeFromPunches({ am_in: "08:09", am_out: "12:00", pm_in: "13:00", pm_out: "17:00" }, sched, cfg).late_minutes, 0, "within the grace period");
});

test("time clock: only one half worked is a half day; rest-day work keeps its status", () => {
  assert.equal(computeFromPunches({ am_in: "08:00", am_out: "12:00" }, sched, cfg).status, "half_day");
  assert.equal(computeFromPunches({ pm_in: "13:00", pm_out: "17:00" }, sched, cfg).status, "half_day");
  const r = computeFromPunches({ am_in: "09:00", am_out: "12:00" }, { dayOff: true }, cfg, "rest_day");
  assert.equal(r.status, "rest_day");
  assert.equal(r.late_minutes, 0);
  assert.equal(r.hours_worked, 3);
});

test("HR plotted days: times must run in order; a day off needs no times", () => {
  assert.deepEqual(checkPlottedDay({ date: "2026-11-16", day_off: true }), { date: "2026-11-16", is_day_off: 1, remarks: null });
  const ok = checkPlottedDay({ date: "2026-11-17", shift_start: "09:00", am_break_start: "11:00", lunch_start: "13:00", lunch_end: "14:00", pm_break_start: "16:00", shift_end: "18:00" });
  assert.equal(ok.is_day_off, 0);
  assert.throws(() => checkPlottedDay({ date: "2026-11-17", shift_start: "09:00", am_break_start: "13:30", lunch_start: "13:00", lunch_end: "14:00", pm_break_start: "16:00", shift_end: "18:00" }), /must run/);
  assert.throws(() => checkPlottedDay({ date: "2026-11-17", shift_start: "9am" }), /HH:MM/);
  assert.deepEqual(checkPlottedDay({ date: "2026-11-18", clear: true }), { date: "2026-11-18", clear: true });
});

test("vacation leave conversion window: 1 December to 31 January, for the year just ending", () => {
  assert.equal(conversionYear("2026-12-01"), 2026);
  assert.equal(conversionYear("2027-01-31"), 2026);
  assert.equal(conversionYear("2027-02-01"), null);
  assert.equal(conversionYear("2026-11-30"), null);
});

test("retirement: years of service and the 25-year vesting split", () => {
  assert.equal(tenureYears("2001-03-15", "2026-03-15"), 25);
  assert.equal(tenureYears("2001-03-16", "2026-03-15"), 24.99);
  assert.equal(tenureYears("2026-01-01", "2025-01-01"), 0);
  assert.deepEqual(withdrawalSplit(100000, 100000, 25, 25), { vested: true, payableC: 200000, forfeitedC: 0 });
  assert.deepEqual(withdrawalSplit(100000, 100000, 24.99, 25), { vested: false, payableC: 100000, forfeitedC: 100000 });
});

// ---- payroll engine: days off, retirement deduction and the VL conversion earning
const settings = {
  days_per_year: 261, hours_per_day: 8, rest_day: 0, rest_day_2: 6, contribution_schedule: "split",
  ot_multiplier_regular: 1.25, ot_multiplier_rest_day: 1.69, ot_multiplier_holiday: 2.6,
  holiday_multiplier_regular: 2, holiday_multiplier_special: 1.3, night_diff_rate: 0.1,
};
const zeroRule = (id) => ({ id, employee_rate: "0", employer_rate: "0", salary_floor: "0", salary_ceiling: "1000000", rounding_step: "0", ec_threshold: "0", ec_amount_low: "0", ec_amount_high: "0" });
const rules = { SSS: zeroRule(1), PHILHEALTH: zeroRule(2), PAGIBIG: zeroRule(3) };
const brackets = [{ annual_from: "0", annual_to: null, base_tax: "0", rate: "0" }];
// 1–15 Nov 2026 with Saturday and Sunday off: Mon 2 – Fri 6 and Mon 9 – Fri 13 = 10 work days
const WORK = ["02", "03", "04", "05", "06", "09", "10", "11", "12", "13"].map((d) => `2026-11-${d}`);
const present = (date) => ({ work_date: date, status: "present", validation_status: "validated", hours_worked: "8.00", late_minutes: 0, undertime_minutes: 0, time_in: "08:00:00", time_out: "17:00:00" });
const run = (o = {}) => computeEmployeePayroll({
  employee: { basic_salary: "20000", rate_basis: "monthly", is_mwe: 0, date_hired: "2020-01-01", date_separated: null },
  period: { start_date: "2026-11-01", end_date: "2026-11-15", pay_frequency: "semi_monthly" }, settings,
  attendance: o.attendance ?? WORK.map(present), leaves: [], payItems: [], adjustments: [],
  overtime: o.overtime || [], holidays: o.holidays || [],
  leaveConversions: o.leaveConversions, retirement: o.retirement, daysOff: o.daysOff, thirteenth: o.thirteenth, rules, brackets,
});

test("engine: two days off a week — Saturday is not an absence", () => {
  const out = run();
  assert.equal(out.record.days_absent, 0);
  assert.equal(out.record.basic_pay, "10000.00");
});

test("engine: an employee's own days off (Sunday and Monday) replace the default", () => {
  const daysOff = new Set(["2026-11-01", "2026-11-02", "2026-11-08", "2026-11-09", "2026-11-15"]);
  const attendance = ["03", "04", "05", "06", "07", "10", "11", "12", "13", "14"].map((d) => present(`2026-11-${d}`));
  const out = run({ daysOff, attendance });
  assert.equal(out.record.days_absent, 0);
});

test("engine: retirement fund 15% — employee share deducted, the company adds the same", () => {
  const out = run({ retirement: { rate_percent: 15, enrollment_id: 7 } });
  // 20,000 × 15% = 3,000 a month → 1,500 per semi-monthly payday
  const d = out.deductions.find((x) => x.code === "RETIREMENT");
  assert.equal(d.amount, "1500.00");
  assert.equal(d.source_id, 7);
  assert.equal(out.record.retirement_company_share, "1500.00");
  assert.equal(out.record.net_pay, "8500.00");
});

test("engine: lost minutes from breaks and lunch are deducted on their own payslip line", () => {
  const attendance = WORK.map(present);
  attendance[0] = { ...attendance[0], overbreak_minutes: 30 };
  attendance[1] = { ...attendance[1], overbreak_minutes: 15 };
  const out = run({ attendance });
  // 20,000 × 12 ÷ 261 = 919.54 a day ÷ 8 = 114.94 an hour; 45 min = 86.21
  const l = out.deductions.find((x) => /Lost hours/.test(x.description));
  assert.equal(l.amount, "86.21");
  assert.match(l.description, /0h 45m/);
  assert.equal(out.record.overbreak_minutes, 45);
});

test("engine: vacation leave conversion is a non-taxable earning", () => {
  const out = run({ leaveConversions: [{ id: 3, conversion_no: "VLC-2026-0001", year: 2026, days: "4.0", daily_rate: "919.54", amount: "3678.16" }] });
  const e = out.earnings.find((x) => x.code === "LEAVE_CONV");
  assert.equal(e.amount, "3678.16");
  assert.equal(out.record.other_earnings, "3678.16");
  assert.equal(out.record.gross_pay, "13678.16");
  assert.equal(out.record.withholding_tax, "0.00");
});

// basic only: 20,000 × 12 ÷ 261 = 919.54 a day, 114.94 an hour (allowances, bonuses and overtime never enter the rate)
test("engine: approved work on a day off — first 8 hours at 130%, the rest at 169%", () => {
  const out = run({ overtime: [{ id: 9, work_date: "2026-11-07", hours: "10", ot_type: "rest_day" }] }); // Saturday, a day off
  const lines = out.earnings.filter((x) => x.code === "OT");
  assert.deepEqual(lines.map((l) => [l.quantity, l.amount]), [[8, "1195.40"], [2, "388.51"]]);
  assert.equal(out.record.overtime_pay, "1583.91");
});

test("engine: regular holiday double pay, special holiday +30%, more when it falls on a day off", () => {
  const worked = (date) => ({ ...present(date), status: "holiday" });
  // on a work day the monthly salary covers the base day: only the premium is added
  assert.equal(run({ holidays: [{ holiday_date: "2026-11-05", name: "Regular", holiday_type: "regular" }], attendance: [...WORK.map(present).filter((a) => a.work_date !== "2026-11-05"), worked("2026-11-05")] }).record.holiday_pay, "919.54");
  assert.equal(run({ holidays: [{ holiday_date: "2026-11-05", name: "Special", holiday_type: "special_non_working" }], attendance: [...WORK.map(present).filter((a) => a.work_date !== "2026-11-05"), worked("2026-11-05")] }).record.holiday_pay, "275.86");
  // on a day off (Saturday) the whole day is paid: regular 260%, special 150%
  assert.equal(run({ holidays: [{ holiday_date: "2026-11-07", name: "Regular", holiday_type: "regular" }], attendance: [...WORK.map(present), worked("2026-11-07")] }).record.holiday_pay, "2390.80");
  assert.equal(run({ holidays: [{ holiday_date: "2026-11-07", name: "Special", holiday_type: "special_non_working" }], attendance: [...WORK.map(present), worked("2026-11-07")] }).record.holiday_pay, "1379.31");
});

test("engine: 13th-month and other bonuses are tax-exempt up to ₱90,000 a year; only the excess is taxed", () => {
  const taxRun = (ytd, amount) => computeEmployeePayroll({
    employee: { basic_salary: "20000", rate_basis: "monthly", is_mwe: 0, date_hired: "2020-01-01", date_separated: null },
    period: { start_date: "2026-11-01", end_date: "2026-11-15", pay_frequency: "semi_monthly" }, settings: { ...settings, bonus_tax_exempt_ceiling: 90000 },
    attendance: WORK.map(present), holidays: [], leaves: [], overtime: [], adjustments: [], ytdBonuses: ytd, rules,
    // a flat 10% tax over ₱0 so the taxable part is easy to read
    brackets: [{ annual_from: "0", annual_to: null, base_tax: "0", rate: "0.10" }],
    payItems: [{ id: 1, amount, component_type: "earning", category: "bonus", is_taxable: 1, component_code: "BONUS", component_name: "Bonus", description: "Year-end bonus" }],
  });
  // salary only: 10,000 × 24 × 10% ÷ 24 = 1,000 tax
  assert.equal(taxRun("0", "50000.00").record.withholding_tax, "1000.00", "₱50,000 bonus, nothing used yet: all exempt");
  assert.equal(taxRun("70000", "50000.00").record.withholding_tax, "4000.00", "₱20,000 left of the exemption: ₱30,000 taxed → +3,000");
  assert.equal(taxRun("90000", "10000.00").record.withholding_tax, "2000.00", "exemption used up: the whole ₱10,000 is taxed");
});

test("benefits: HMO covers up to 3; insurance names 1–2 beneficiaries who are spouse or family", () => {
  const plans = { hmo: { provider: "Cocolife", coverage: 250000, maxDependents: 3 }, insurance: { provider: "Insurer", maxBeneficiaries: 2 } };
  assert.deepEqual(checkBenefit({ benefit_type: "hmo", dependent_ids: ["4", "5"] }, plans).values.dependent_ids, [4, 5]);
  assert.ok(checkBenefit({ benefit_type: "hmo", dependent_ids: ["1", "2", "3", "4"] }, plans).errors.dependent_ids);
  const one = checkBenefit({ benefit_type: "life_accident", ben_1_name: "Ana Cruz", ben_1_relationship: "spouse" }, plans);
  assert.deepEqual(one.errors, {});
  assert.equal(one.values.beneficiaries[0].share_percent, 100);
  const two = checkBenefit({ benefit_type: "life_accident", ben_1_name: "Ana Cruz", ben_1_relationship: "spouse", ben_2_name: "Ben Cruz", ben_2_relationship: "sibling" }, plans);
  assert.deepEqual(two.values.beneficiaries.map((b) => b.share_percent), [50, 50]);
  assert.ok(checkBenefit({ benefit_type: "life_accident", ben_1_name: "A Friend", ben_1_relationship: "other" }, plans).errors.ben_1_relationship);
  assert.ok(checkBenefit({ benefit_type: "life_accident" }, plans).errors.ben_1_name);
  assert.ok(checkBenefit({ benefit_type: "other" }, plans).errors.benefit_type, "only the two company benefits");
});

test("salary loan: add-on interest, payday deduction and the policy limits", () => {
  const policy = { terms: [3, 6, 12], minAmount: 1000, maxMultiple: 2, interestRate: 0.01, maxDeductionPercent: 25 };
  // ₱18,000 a month, semi-monthly: payday basic 9,000 → deduction limit 2,250; loan limit 36,000
  const q = loanQuote({ principal: "12000", termMonths: 6, monthlyBasic: "18000.00", payFrequency: "semi_monthly" }, policy);
  assert.deepEqual([q.interest, q.total, q.paydays, q.amortization, q.errors.length], ["720.00", "12720.00", 12, "1060.00", 0]);
  assert.equal(loanQuote({ principal: "10000", termMonths: 12, monthlyBasic: "18000.00", payFrequency: "semi_monthly" }, policy).amortization, "466.67", "rounded up; the last payday takes the rest");
  assert.match(loanQuote({ principal: "40000", termMonths: 12, monthlyBasic: "18000.00", payFrequency: "semi_monthly" }, policy).errors.join(" "), /up to 2 months/);
  assert.match(loanQuote({ principal: "30000", termMonths: 3, monthlyBasic: "18000.00", payFrequency: "semi_monthly" }, policy).errors.join(" "), /more than 25%/);
  assert.match(loanQuote({ principal: "500", termMonths: 3, monthlyBasic: "18000.00", payFrequency: "semi_monthly" }, policy).errors.join(" "), /smallest loan/);
  assert.match(loanQuote({ principal: "5000", termMonths: 9, monthlyBasic: "18000.00", payFrequency: "semi_monthly" }, policy).errors.join(" "), /term/);
  assert.equal(serviceMonths("2025-11-14", "2026-11-13"), 11);
  assert.equal(serviceMonths("2025-11-13", "2026-11-13"), 12);
});

test("pay schedule: kinsenas paid on the 25th, katapusan on the 10th of the next month", () => {
  assert.deepEqual(fixedHalf(2026, 11, 1), { start: "2026-11-01", end: "2026-11-15", pay: "2026-11-25" });
  assert.deepEqual(fixedHalf(2026, 11, 2), { start: "2026-11-16", end: "2026-11-30", pay: "2026-12-10" });
  assert.deepEqual(fixedHalf(2026, 12, 2), { start: "2026-12-16", end: "2026-12-31", pay: "2027-01-10" }, "across the year");
  assert.deepEqual(fixedHalf(2028, 2, 2), { start: "2028-02-16", end: "2028-02-29", pay: "2028-03-10" }, "leap year");
});

test("pay schedule: a payday on a weekend or holiday is released the working day before; 13th month by 24 December", () => {
  assert.equal(releaseDateFor("2026-10-25", new Set()), "2026-10-23", "Sunday → Friday");
  assert.equal(releaseDateFor("2026-11-25", new Set()), "2026-11-25", "a Wednesday stays");
  assert.equal(releaseDateFor("2026-12-25", new Set(["2026-12-25"]), "2026-12-24"), "2026-12-24");
  assert.equal(releaseDateFor("2027-12-25", new Set(), "2027-12-24"), "2027-12-24", "Friday 24th");
  assert.equal(releaseDateFor("2028-12-25", new Set(), "2028-12-24"), "2028-12-22", "24th is a Sunday → Friday 22nd");
  assert.equal(releaseDateFor("2027-01-10", new Set()), "2027-01-08", "Sunday → Friday");
});

test("engine: 13th month pay = basic earned this year ÷ 12, tax-exempt within the ₱90,000 ceiling", () => {
  // ₱20,000 a month: 22 earlier half-months (₱220,000) + this one (₱10,000) = ₱230,000 ÷ 12 = ₱19,166.67
  const out = run({ thirteenth: { ytdBasic: "220000.00" } });
  const e = out.earnings.find((x) => x.code === "THIRTEENTH");
  assert.equal(e.amount, "19166.67");
  assert.equal(out.record.withholding_tax, "0.00");
});
