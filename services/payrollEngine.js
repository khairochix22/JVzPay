// JVzPay payroll computation engine — a PURE function (no database access) so every rule can be unit-tested.
// Money is integer CENTAVOS internally; each line is rounded half-up to the centavo; DECIMAL strings at the edges.
//
// Method (documented on every record in computation_notes):
//  • Rates: monthly → daily = monthly × 12 ÷ days_per_year; daily → monthly-equivalent = daily × days_per_year ÷ 12;
//    hourly = daily ÷ standard hours. Periods: weekly 52/yr, semi-monthly 24/yr, monthly 12/yr.
//  • Scheduled days = calendar days of the period within employment, excluding the weekly rest day and non-working holidays.
//  • Only VALIDATED attendance is used. A scheduled day with no validated record and no approved leave counts as absent
//    (with a warning). Approved paid leave is paid; leave without pay counts as absence.
//  • Monthly-rated: basic = monthly ÷ periods-per-month (pro-rated by scheduled days when hired/separated mid-period);
//    absences, lateness and undertime are deducted at the daily/hourly rate (capped at basic pay).
//    Daily-rated: basic = (days worked + paid leave days) × daily rate; lateness/undertime deducted.
//    Hourly-rated: basic = (regular hours worked + paid leave days × standard hours) × hourly rate.
//  • Holidays: daily/hourly-rated employees are paid 100% for an unworked regular holiday; work on a regular holiday is
//    paid at the regular-holiday multiplier, on a special non-working day at the special multiplier. Monthly-rated
//    employees already receive holidays in their salary, so only the premium portion is added when they work.
//  • Overtime = approved hours × hourly rate × multiplier for its type. Approved rest-day work on a day off: the first
//    8 hours at the rest-day rate (130%), beyond that 169%. Work on a holiday that is also a day off: regular 260%,
//    special 150%; overtime then 338% / 195%. All rates use the BASIC salary only (allowances, bonuses and OT excluded). Night differential = minutes worked after 22:00 ×
//    hourly rate × ND rate (overnight shifts are not modelled).
//  • Statutory contributions use the employee's MONTHLY-EQUIVALENT CONTRACT RATE as the compensation base (clamped to the
//    rule's floor/ceiling, SSS rounded to its credit step), and are skipped when the period has no net compensation.
//    'split' schedule divides the monthly amount across the month's periods; 'last' deducts it in the month's last period.
//  • Withholding tax (annualised method): (taxable earnings − absence/late − employee contributions) × periods per year →
//    graduated annual table → ÷ periods per year. Minimum wage earners are exempt. Year-end annualisation, 13th-month and
//    de minimis ceilings are not modelled.
//  • Lost hours: minutes past a plotted break or lunch (attendance overbreak_minutes) are deducted at the hourly rate,
//    on their own payslip line. Hourly-rated pay already leaves them out (they are not in hours worked).
//  • Bonuses and incentives are taxable only above the yearly exemption for 13th-month pay and other benefits
//    (settings bonus_tax_exempt_ceiling, ₱90,000), counted with input.ytdBonuses from earlier payroll that year.
//  • 13th-month pay (input.thirteenth = { ytdBasic }): basic salary earned this year ÷ 12, with the December 1–15 payroll.
//  • Loans/other deductions are reduced (never statutory or tax) if they would make net pay negative.
//  • Days off: each employee's own two days off (input.daysOff, a Set of dates) — else the settings' rest days.
//  • Vacation leave conversions (input.leaveConversions) are paid as a non-taxable earning (monetised unused VL of up
//    to 10 days a year is a de minimis benefit).
//  • Retirement fund (input.retirement = { rate_percent, enrollment_id }): rate × monthly-equivalent basic salary ÷ periods
//    in the month is deducted after tax (reduced, like a loan, if net pay would go negative); the company adds the same
//    amount (record.retirement_company_share — an employer cost, never deducted from the employee).

export const PERIODS_PER_YEAR = { weekly: 52, semi_monthly: 24, monthly: 12 };

export const toC = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const s = String(v).trim();
  const neg = s.startsWith("-");
  const [w, f = ""] = s.replace("-", "").split(".");
  const c = Number(w) * 100 + Number((f + "00").slice(0, 2)) + (f.length > 2 && f[2] >= "5" ? 1 : 0);
  return neg ? -c : c;
};
export const fromC = (c) => { const n = Math.round(c); const a = Math.abs(n); return `${n < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`; };
const r = (x) => Math.round(x + Number.EPSILON * Math.sign(x)); // centavo rounding (half away from zero)
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmt = (c) => `₱${fromC(c).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

export class PayrollConfigError extends Error {}

// lost time from exceeding breaks or lunch, as printed on the payslip
const lostLabel = (min) => `Lost hours: breaks/lunch exceeded (${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m)`;

/** Statutory share for one agency from the MONTHLY compensation base (centavos). Exported for unit tests. */
export function contribution(rule, monthlyBaseC) {
  let base = r(monthlyBaseC);
  const step = toC(rule.rounding_step);
  if (step > 0) base = Math.round(base / step) * step;
  base = Math.max(toC(rule.salary_floor), Math.min(toC(rule.salary_ceiling), base));
  // a lower band (Pag-IBIG: 1% at ₱1,500 or below) replaces the employee rate; the employer rate is unchanged
  const lowBand = toC(rule.low_income_ceiling || 0) > 0 && base <= toC(rule.low_income_ceiling);
  const ee = r(base * Number(lowBand ? rule.low_income_employee_rate : rule.employee_rate));
  const er = r(base * Number(rule.employer_rate));
  const ec = toC(rule.ec_threshold) > 0 ? (base < toC(rule.ec_threshold) ? toC(rule.ec_amount_low) : toC(rule.ec_amount_high)) : 0;
  return { base, ee, er, ec };
}

/** Annual tax (centavos) from the graduated table. Exported for unit tests. */
export function annualTax(brackets, annualC) {
  if (annualC <= 0) return 0;
  const b = [...brackets].sort((a, c) => toC(a.annual_from) - toC(c.annual_from))
    .find((x) => annualC > toC(x.annual_from) && (x.annual_to === null || annualC <= toC(x.annual_to)))
    || brackets.find((x) => toC(x.annual_from) === 0);
  if (!b) throw new PayrollConfigError("No withholding tax bracket covers this income.");
  return r(toC(b.base_tax) + (annualC - toC(b.annual_from)) * Number(b.rate));
}

/**
 * Computes one employee's payroll for one period.
 * input = { employee, period, settings, attendance[], holidays[], leaves[], overtime[], payItems[], adjustments[], rules{SSS,PHILHEALTH,PAGIBIG}, brackets[] }
 */
export function computeEmployeePayroll(input) {
  const { employee: e, period: p, settings: s } = input;
  const notes = [];
  const warnings = [];
  const earnings = [];
  const deductions = [];
  const contributions = [];
  const ppy = PERIODS_PER_YEAR[p.pay_frequency];
  if (!ppy) throw new PayrollConfigError(`Unsupported pay frequency ${p.pay_frequency}`);
  const ppm = ppy / 12;
  const hpd = Number(s.hours_per_day);
  const dpy = Number(s.days_per_year);

  // ---- rates (fractional centavos; rounded only on lines)
  const rateC = toC(e.basic_salary);
  let monthlyC, dailyC, hourlyC;
  if (e.rate_basis === "monthly") { monthlyC = rateC; dailyC = (rateC * 12) / dpy; hourlyC = dailyC / hpd; }
  else if (e.rate_basis === "daily") { dailyC = rateC; monthlyC = (rateC * dpy) / 12; hourlyC = dailyC / hpd; }
  else { hourlyC = rateC; dailyC = rateC * hpd; monthlyC = (dailyC * dpy) / 12; }
  notes.push(`Rates: monthly-equivalent ${fmt(monthlyC)}, daily ${fmt(dailyC)}, hourly ${fmt(hourlyC)} (${dpy} days/yr, ${hpd} h/day).`);

  // ---- calendar
  const start = parse(p.start_date), end = parse(p.end_date);
  const hired = parse(e.date_hired), separated = e.date_separated ? parse(e.date_separated) : null;
  const holidayByDate = new Map((input.holidays || []).map((h) => [String(h.holiday_date).slice(0, 10), h]));
  const attByDate = new Map((input.attendance || []).map((a) => [String(a.work_date).slice(0, 10), a]));
  const restDays = [s.rest_day, s.rest_day_2].filter((x) => x !== undefined && x !== null && x !== "").map(Number);
  const isDayOff = (d) => (input.daysOff ? input.daysOff.has(iso(d)) : restDays.includes(d.getDay()));
  const leaveDay = new Map(); // date -> { paid, fraction, code }
  for (const l of input.leaves || []) {
    for (let d = parse(l.start_date); d <= parse(l.end_date); d.setDate(d.getDate() + 1)) {
      leaveDay.set(iso(d), { paid: !!l.is_paid, fraction: Number(l.days) === 0.5 ? 0.5 : 1, code: l.code });
    }
  }
  let periodScheduled = 0, scheduled = 0, worked = 0, paidLeave = 0, unpaidLeave = 0, absent = 0, missing = 0, pendingDays = 0;
  let lateMin = 0, utMin = 0, lostMin = 0, regHours = 0, ndMin = 0;
  let unworkedRegHolidays = 0;
  const workedHolidays = []; // { type, hours }
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = iso(d);
    const hol = holidayByDate.get(day);
    const nonWorkingHoliday = hol && hol.holiday_type !== "special_working";
    const isRest = isDayOff(d);
    const employed = d >= hired && (!separated || d <= separated);
    const att = attByDate.get(day);
    const usable = att && att.validation_status !== "pending";
    if (att && att.validation_status === "pending") pendingDays++;
    const workedHours = usable && ["present", "late", "half_day", "holiday", "rest_day"].includes(att.status) ? Number(att.hours_worked) : 0;
    if (usable && workedHours > 0 && att.time_out && toMin(att.time_out) > 22 * 60) ndMin += toMin(att.time_out) - Math.max(22 * 60, toMin(att.time_in) || 0);

    if (nonWorkingHoliday) {
      if (!employed) continue; // holidays are not scheduled work days
      if (workedHours > 0) workedHolidays.push({ type: hol.holiday_type, hours: workedHours, name: hol.name, restDay: isRest });
      else if (hol.holiday_type === "regular" && !isRest) unworkedRegHolidays++;
      continue;
    }
    if (isRest) {
      if (employed && workedHours > 0) notes.push(`Work on rest day ${day} is paid only through approved rest-day overtime.`);
      continue;
    }
    periodScheduled++;
    if (!employed) continue;
    scheduled++;
    const lv = leaveDay.get(day);
    if (lv && (!usable || att.status === "on_leave" || lv.fraction === 0.5)) {
      if (lv.paid) paidLeave += lv.fraction; else unpaidLeave += lv.fraction;
      if (lv.fraction === 0.5) {
        if (usable && ["present", "late", "half_day"].includes(att.status)) { worked += 0.5; regHours += Math.min(workedHours, hpd / 2); }
        else absent += 0.5;
      }
      continue;
    }
    if (!usable) { absent += 1; missing += 1; continue; }
    switch (att.status) {
      case "present": case "late": worked += 1; regHours += workedHours; lateMin += Number(att.late_minutes); utMin += Number(att.undertime_minutes); lostMin += Number(att.overbreak_minutes || 0); break;
      case "half_day": worked += 0.5; absent += 0.5; regHours += workedHours; lateMin += Number(att.late_minutes); lostMin += Number(att.overbreak_minutes || 0); break;
      case "on_leave": unpaidLeave += 1; warnings.push(`${day}: marked on leave without an approved leave application — treated as unpaid.`); break;
      case "absent": absent += 1; break;
      default: absent += 1; break; // holiday/rest_day status on a scheduled day without a matching holiday
    }
  }
  if (missing) warnings.push(`${missing} scheduled day(s) had no validated attendance and were treated as absent.`);
  if (pendingDays) warnings.push(`${pendingDays} day(s) of attendance are still pending validation and were not used.`);
  const absences = absent + unpaidLeave;

  // ---- basic pay & attendance deductions
  let basicC = 0, absenceDedC = 0;
  const tardyMin = lateMin + utMin;
  if (e.rate_basis === "monthly") {
    const full = monthlyC / ppm;
    basicC = r(periodScheduled > 0 ? (full * scheduled) / periodScheduled : 0);
    if (scheduled < periodScheduled) notes.push(`Pro-rated for employment: ${scheduled} of ${periodScheduled} scheduled days.`);
    earnings.push({ code: "BASIC", description: `Basic pay (${p.pay_frequency.replace("_", "-")} share of monthly rate)`, quantity: 1, rate: fromC(r(full)), amount: basicC, source_type: "attendance" });
    // a period with nothing worked or paid earns nothing (the 313-day daily rate alone would leave a small residue)
    const absC = worked + paidLeave === 0 && scheduled > 0 ? basicC : r(absences * dailyC);
    const tardyC = r((tardyMin / 60) * hourlyC);
    const lostC = r((lostMin / 60) * hourlyC);
    absenceDedC = Math.min(basicC, absC + tardyC + lostC);
    const absTaken = Math.min(absC, basicC);
    const tardyTaken = Math.min(tardyC, absenceDedC - absTaken);
    if (absC) deductions.push({ code: "ABSENCE", description: `Absences (${absences} day${absences === 1 ? "" : "s"} × ${fmt(dailyC)})`, amount: absTaken, source_type: "attendance" });
    if (tardyTaken > 0) deductions.push({ code: "ABSENCE", description: `Late/undertime (${tardyMin} min)`, amount: tardyTaken, source_type: "attendance" });
    if (absenceDedC - absTaken - tardyTaken > 0) deductions.push({ code: "ABSENCE", description: lostLabel(lostMin), amount: absenceDedC - absTaken - tardyTaken, source_type: "attendance" });
  } else if (e.rate_basis === "daily") {
    const days = worked + paidLeave;
    basicC = r(days * dailyC);
    earnings.push({ code: "BASIC", description: `Basic pay (${days} day${days === 1 ? "" : "s"} × ${fmt(dailyC)})`, quantity: days, rate: fromC(r(dailyC)), amount: basicC, source_type: "attendance" });
    const tardyC = Math.min(basicC, r((tardyMin / 60) * hourlyC));
    const lostC = Math.min(basicC - tardyC, r((lostMin / 60) * hourlyC));
    absenceDedC = tardyC + lostC;
    if (tardyC) deductions.push({ code: "ABSENCE", description: `Late/undertime (${tardyMin} min)`, amount: tardyC, source_type: "attendance" });
    if (lostC) deductions.push({ code: "ABSENCE", description: lostLabel(lostMin), amount: lostC, source_type: "attendance" });
  } else {
    const hours = Math.round((regHours + paidLeave * hpd) * 100) / 100;
    basicC = r(hours * hourlyC);
    earnings.push({ code: "BASIC", description: `Basic pay (${hours} h × ${fmt(hourlyC)})`, quantity: hours, rate: fromC(r(hourlyC)), amount: basicC, source_type: "attendance" });
  }
  if (paidLeave) notes.push(`Paid leave: ${paidLeave} day(s). Unpaid leave/absences: ${absences} day(s).`);

  // ---- holiday pay
  let holidayC = 0;
  if (e.rate_basis !== "monthly" && unworkedRegHolidays) {
    const c = r(unworkedRegHolidays * dailyC);
    holidayC += c;
    earnings.push({ code: "HOLIDAY", description: `Regular holiday pay, not worked (${unworkedRegHolidays} day${unworkedRegHolidays === 1 ? "" : "s"})`, quantity: unworkedRegHolidays, rate: fromC(r(dailyC)), amount: c, source_type: "holiday" });
  }
  // a holiday that falls on the employee's day off pays more (regular 260%, special 150%), and a monthly salary does not
  // cover a day off, so the whole rate is paid; on a work day the monthly salary already covers the base day
  const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
  for (const h of workedHolidays) {
    const mult = h.type === "regular"
      ? (h.restDay ? num(s.holiday_multiplier_regular_rest_day, 2.6) : Number(s.holiday_multiplier_regular))
      : (h.restDay ? num(s.holiday_multiplier_special_rest_day, 1.5) : Number(s.holiday_multiplier_special));
    const factor = e.rate_basis === "monthly" && !h.restDay ? mult - 1 : mult;
    const c = r(h.hours * hourlyC * factor);
    holidayC += c;
    earnings.push({ code: "HOLIDAY", description: `Work on ${h.name} (${h.hours} h × ${factor * 100}%)`, quantity: h.hours, rate: fromC(r(hourlyC * factor)), amount: c, source_type: "holiday" });
  }

  // ---- overtime & night differential
  let otC = 0, otHours = 0;
  const mult = { regular: Number(s.ot_multiplier_regular), rest_day: Number(s.ot_multiplier_rest_day), holiday: Number(s.ot_multiplier_holiday) };
  const restWork = num(s.rest_day_multiplier, 1.3);
  const otLine = (o, hours, m, what) => {
    const c = r(hours * hourlyC * m);
    otC += c;
    earnings.push({ code: "OT", description: `${what} ${String(o.work_date).slice(0, 10)} (${hours} h × ${Math.round(m * 100)}%)`, quantity: hours, rate: fromC(r(hourlyC * m)), amount: c, source_type: "overtime", source_id: o.id });
  };
  for (const o of input.overtime || []) {
    const hours = Number(o.hours), day = parse(o.work_date);
    const hol = holidayByDate.get(iso(day));
    const onHoliday = hol && hol.holiday_type !== "special_working";
    const off = isDayOff(day);
    otHours += hours;
    if (off && !onHoliday && o.ot_type === "rest_day") {
      // work on a day off: the first 8 hours at the rest-day rate (130%), the hours beyond at the rest-day overtime rate (169%)
      const base = Math.min(hours, hpd), extra = Math.round((hours - base) * 100) / 100;
      otLine(o, base, restWork, "Rest-day work");
      if (extra > 0) otLine(o, extra, mult.rest_day, "Rest-day overtime");
    } else {
      // overtime on a holiday that is also a day off earns the rest-day premium on top (regular 338%, special 195%)
      const m = mult[o.ot_type] * (off && onHoliday ? restWork : 1);
      otLine(o, hours, m, "Overtime");
    }
  }
  let ndC = 0;
  if (ndMin > 0) {
    ndC = r((ndMin / 60) * hourlyC * Number(s.night_diff_rate));
    earnings.push({ code: "NIGHTDIFF", description: `Night differential (${ndMin} min after 22:00)`, quantity: Math.round((ndMin / 60) * 100) / 100, rate: fromC(r(hourlyC * Number(s.night_diff_rate))), amount: ndC, source_type: "attendance" });
  }

  // ---- allowances, other earnings, deductions from pay items and adjustments
  let allowC = 0, otherEarnC = 0, nonTaxableC = 0;
  const loanLines = [];
  // 13th-month pay and other bonuses are tax-exempt up to the yearly ceiling (TRAIN law: ₱90,000); only the excess is taxed.
  // input.ytdBonuses = bonuses already paid this year in other payroll records.
  const ceilingC = toC(s.bonus_tax_exempt_ceiling ?? 90000);
  let exemptLeftC = Math.max(0, ceilingC - toC(input.ytdBonuses || 0)), bonusExemptC = 0;
  const exemptBonus = (category, amount, taxable) => {
    if (!["bonus", "incentive"].includes(category)) return;
    const x = taxable ? Math.min(amount, exemptLeftC) : 0;
    exemptLeftC -= x; bonusExemptC += x; nonTaxableC += x;
  };
  for (const it of input.payItems || []) {
    const amount = toC(it.amount);
    if (it.component_type === "earning") {
      if (it.category === "allowance") allowC += amount; else otherEarnC += amount;
      if (!it.is_taxable) nonTaxableC += amount;
      exemptBonus(it.category, amount, !!it.is_taxable);
      earnings.push({ code: it.component_code, description: it.description || it.component_name, quantity: 1, rate: fromC(amount), amount, source_type: "pay_item", source_id: it.id, taxable: !!it.is_taxable });
    } else {
      const due = it.remaining_balance !== null && it.remaining_balance !== undefined ? Math.min(amount, toC(it.remaining_balance)) : amount;
      if (due > 0) loanLines.push({ code: it.component_code, description: it.description || it.component_name, amount: due, source_type: "pay_item", source_id: it.id, reducible: true });
    }
  }
  for (const a of input.adjustments || []) {
    const amount = toC(a.amount);
    if (a.adjustment_type === "earning") {
      otherEarnC += amount;
      if (!a.is_taxable) nonTaxableC += amount;
      exemptBonus(a.category, amount, !!a.is_taxable);
      earnings.push({ code: a.component_code, description: `Adjustment ${a.adjustment_no}: ${a.reason}`.slice(0, 200), quantity: 1, rate: fromC(amount), amount, source_type: "adjustment", source_id: a.id, taxable: !!a.is_taxable });
    } else {
      loanLines.push({ code: a.component_code, description: `Adjustment ${a.adjustment_no}: ${a.reason}`.slice(0, 200), amount, source_type: "adjustment", source_id: a.id, reducible: true });
    }
  }

  // 13th-month pay (PD 851): one twelfth of the basic salary actually earned in the year (absences and lost time
  // excluded), paid with the 1–15 December payroll; tax-exempt within the yearly bonus ceiling like other bonuses
  if (input.thirteenth) {
    const earnedC = toC(input.thirteenth.ytdBasic || 0) + Math.max(0, basicC - absenceDedC);
    const amount = r(earnedC / 12);
    if (amount > 0) {
      otherEarnC += amount;
      exemptBonus("bonus", amount, true);
      earnings.push({ code: "THIRTEENTH", description: `13th month pay (${fmt(earnedC)} basic earned this year ÷ 12)`, quantity: 1, rate: fromC(amount), amount, source_type: "thirteenth", taxable: true });
    }
  }

  for (const c of input.leaveConversions || []) {
    const amount = toC(c.amount);
    otherEarnC += amount; nonTaxableC += amount;
    earnings.push({ code: "LEAVE_CONV", description: `Vacation leave conversion ${c.conversion_no} (${Number(c.days)} day${Number(c.days) === 1 ? "" : "s"} of ${c.year})`, quantity: Number(c.days), rate: fromC(toC(c.daily_rate)), amount, source_type: "leave_conversion", source_id: c.id, taxable: false });
  }

  if (bonusExemptC) notes.push(`Bonuses: ${fmt(bonusExemptC)} tax-exempt (13th-month and other benefits up to ${fmt(ceilingC)} a year); any excess is taxed.`);

  const grossC = basicC + otC + holidayC + ndC + allowC + otherEarnC;
  const compensationC = grossC - absenceDedC; // what the employee actually earned this period

  // ---- statutory contributions
  let eeTotal = 0, erTotal = 0;
  if (compensationC > 0) {
    const lastOfMonth = new Date(end.getFullYear(), end.getMonth() + 1, 0);
    const isLastPeriodOfMonth = p.pay_frequency === "monthly" || iso(end) === iso(lastOfMonth) || (p.pay_frequency === "weekly" && new Date(end.getTime() + 7 * 864e5).getMonth() !== end.getMonth());
    const firstHalf = p.pay_frequency === "semi_monthly" && start.getDate() <= 15;
    for (const agency of ["SSS", "PHILHEALTH", "PAGIBIG"]) {
      const rule = input.rules?.[agency];
      if (!rule) throw new PayrollConfigError(`No ${agency} contribution rule is effective on ${p.end_date}.`);
      const m = contribution(rule, monthlyC);
      const share = (c) => {
        if (p.pay_frequency === "monthly") return c;
        if (s.contribution_schedule === "last") return isLastPeriodOfMonth ? c : 0;
        if (p.pay_frequency === "semi_monthly") return firstHalf ? Math.floor(c / 2) : c - Math.floor(c / 2);
        return r((c * 12) / 52);
      };
      let ee = share(m.ee);
      const er = share(m.er), ec = share(m.ec);
      const room = compensationC - eeTotal; // an employee share can never exceed what was actually earned
      if (ee > room) { warnings.push(`${agency} employee share reduced from ${fmt(ee)} to ${fmt(Math.max(0, room))} because earnings were too low; settle the shortfall manually.`); ee = Math.max(0, room); }
      if (ee + er + ec === 0) continue;
      eeTotal += ee; erTotal += er + ec;
      contributions.push({ agency, rule_id: rule.id, base_amount: fromC(m.base), employee_share: ee, employer_share: er, ec_share: ec });
      deductions.push({ code: agency, description: `${agency === "PHILHEALTH" ? "PhilHealth" : agency === "PAGIBIG" ? "Pag-IBIG" : "SSS"} employee share`, amount: ee, source_type: "statutory", source_id: rule.id });
    }
    notes.push(`Contributions on monthly base ${fmt(monthlyC)} (${s.contribution_schedule === "last" ? "deducted in the last period of the month" : "split across the month's periods"}).`);
  } else {
    notes.push("No compensation earned this period: statutory contributions and tax were not deducted.");
  }

  // ---- withholding tax
  let taxC = 0;
  if (e.is_mwe) notes.push("Minimum wage earner: exempt from withholding tax.");
  else if (compensationC > 0) {
    const taxableC = Math.max(0, compensationC - nonTaxableC - eeTotal);
    taxC = r(annualTax(input.brackets || [], taxableC * ppy) / ppy);
    notes.push(`Withholding tax: taxable ${fmt(taxableC)} × ${ppy} = ${fmt(taxableC * ppy)} annualised.`);
  }
  if (taxC) deductions.push({ code: "WTAX", description: "Withholding tax", amount: taxC, source_type: "tax" });

  // ---- retirement fund: employee share deducted every payday, the company adds the same amount
  if (input.retirement && compensationC > 0) {
    const pct = Number(input.retirement.rate_percent);
    const due = r((monthlyC * pct) / 100 / ppm);
    loanLines.unshift({ code: "RETIREMENT", description: `Retirement fund (${pct}% of basic salary)`, amount: due, source_type: "retirement", source_id: input.retirement.enrollment_id, reducible: true });
  }

  // ---- reducible deductions may not push net pay below zero
  let available = grossC - absenceDedC - eeTotal - taxC;
  for (const l of loanLines) {
    const take = Math.max(0, Math.min(l.amount, available));
    if (take < l.amount) warnings.push(`${l.description}: reduced from ${fmt(l.amount)} to ${fmt(take)} so net pay is not negative.`);
    available -= take;
    if (take > 0) deductions.push({ ...l, amount: take });
  }
  const retirementC = deductions.filter((d) => d.source_type === "retirement").reduce((a, d) => a + d.amount, 0);
  if (retirementC) notes.push(`Retirement fund: ${fmt(retirementC)} from the employee and ${fmt(retirementC)} from the company.`);
  const otherDedC = deductions.filter((d) => !["statutory", "tax"].includes(d.source_type)).reduce((a, d) => a + d.amount, 0);
  const totalDedC = eeTotal + taxC + otherDedC;
  const netC = grossC - totalDedC;
  if (netC < 0) throw new PayrollConfigError(`Net pay would be negative (${fmt(netC)}). Review attendance and deductions.`);

  return {
    record: {
      rate_basis: e.rate_basis, rate_amount: fromC(rateC),
      days_worked: worked + paidLeave, days_absent: absences, late_minutes: lateMin, undertime_minutes: utMin, overbreak_minutes: lostMin, overtime_hours: Math.round(otHours * 100) / 100,
      basic_pay: fromC(basicC), overtime_pay: fromC(otC), holiday_pay: fromC(holidayC), night_diff_pay: fromC(ndC),
      allowances: fromC(allowC), other_earnings: fromC(otherEarnC), gross_pay: fromC(grossC),
      statutory_employee: fromC(eeTotal), withholding_tax: fromC(taxC), other_deductions: fromC(otherDedC),
      total_deductions: fromC(totalDedC), net_pay: fromC(netC), employer_contributions: fromC(erTotal), retirement_company_share: fromC(retirementC),
    },
    earnings: earnings.map((x) => ({ ...x, amount: fromC(x.amount) })),
    deductions: deductions.map((x) => ({ ...x, amount: fromC(x.amount) })),
    contributions: contributions.map((x) => ({ ...x, employee_share: fromC(x.employee_share), employer_share: fromC(x.employer_share), ec_share: fromC(x.ec_share) })),
    notes, warnings,
    totals: { grossC, netC, totalDedC, erTotal, absenceDedC, otC, eeTotal, taxC, retirementC },
  };
}
