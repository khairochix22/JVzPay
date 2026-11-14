// Data analytics (Module 9). Every figure comes from finalized/released payroll, validated records and posted journals.
// Forecasts are computed separately, labelled as projections, and never written to any table.
import { select, selectOne } from "../lib/db.js";
import { toCents, fromCents } from "../lib/money.js";
import { getSetting } from "../lib/settings.js";
import { fullName } from "./employeeService.js";
import { PAYROLL_EXPENSE_SQL } from "../lib/payrollCost.js";

const LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const lastDay = (key) => { const [y, m] = key.split("-").map(Number); return `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };
const monthLabel = (key) => { const [y, m] = key.split("-").map(Number); return `${LABELS[m - 1]} ${String(y).slice(2)}`; };
function monthsBetween(from, to) { const out = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number); while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 60) break; } return out; }
const peso = (c) => Number(fromCents(c));

/**
 * Ordinary least squares on (t, y) with an approximate 80% prediction interval: ŷ ± 1.282 · s · √(1 + 1/n + (t−t̄)²/Sxx).
 * Pure and exported for tests. Needs at least 3 observations; projections are floored at zero.
 */
export function linearForecast(values, horizon = 3) {
  const n = values.length;
  if (n < 3) return null;
  const tBar = (n - 1) / 2, yBar = values.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  values.forEach((y, t) => { sxx += (t - tBar) ** 2; sxy += (t - tBar) * (y - yBar); });
  const slope = sxy / sxx, intercept = yBar - slope * tBar;
  const sse = values.reduce((a, y, t) => a + (y - (intercept + slope * t)) ** 2, 0);
  const s = Math.sqrt(sse / (n - 2));
  const points = [];
  for (let h = 1; h <= horizon; h++) {
    const t = n - 1 + h;
    const value = intercept + slope * t;
    const margin = 1.282 * s * Math.sqrt(1 + 1 / n + (t - tBar) ** 2 / sxx);
    points.push({ value: Math.max(0, value), lower: Math.max(0, value - margin), upper: Math.max(0, value + margin) });
  }
  return { slope, intercept, s, n, points };
}

const OPEX_SLOTS = { 5040: 1, 5110: 2, 5120: 3, 5130: 4, 5190: 5 };

function readFilters(q) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const okM = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || "");
  const id = (s) => (/^\d+$/.test(s || "") ? Number(s) : null);
  const month = okM(q.month) ? q.month : "", year = /^\d{4}$/.test(q.year || "") ? q.year : "";
  let from = okM(q.from) ? q.from : ym(start), to = okM(q.to) ? q.to : ym(now);
  if (month) from = to = month; // a single month or a whole year replaces the from/to range
  else if (year) { from = `${year}-01`; to = `${year}-12` < ym(now) ? `${year}-12` : ym(now); }
  if (from > to) [from, to] = [to, from];
  return { from, to, month, year, department: id(q.department), employee: id(q.employee), category: id(q.category), period: id(q.period) };
}

function payrollWhere(f, fromDate, toDate) {
  const w = ["r.status IN ('finalized','released')", "r.active_flag = 1", "p.end_date BETWEEN ? AND ?"], a = [fromDate, toDate];
  if (f.department) { w.push("e.department_id = ?"); a.push(f.department); }
  if (f.employee) { w.push("r.employee_id = ?"); a.push(f.employee); }
  if (f.period) { w.push("r.period_id = ?"); a.push(f.period); }
  return [w.join(" AND "), a];
}
const PAYROLL_FROM = "FROM payroll_records r JOIN payroll_periods p ON p.id = r.period_id JOIN employees e ON e.id = r.employee_id";

function attendanceWhere(f, fromDate, toDate) {
  const w = ["a.work_date BETWEEN ? AND ?"], x = [fromDate, toDate];
  if (f.department) { w.push("e.department_id = ?"); x.push(f.department); }
  if (f.employee) { w.push("a.employee_id = ?"); x.push(f.employee); }
  return [w.join(" AND "), x];
}

async function payrollTotals(f, fromDate, toDate) {
  const [w, a] = payrollWhere(f, fromDate, toDate);
  return selectOne(`SELECT COALESCE(SUM(${PAYROLL_EXPENSE_SQL}),0) cost, COALESCE(SUM(r.gross_pay),0) gross, COALESCE(SUM(r.net_pay),0) net, COALESCE(SUM(r.employer_contributions),0) er, COALESCE(SUM(r.overtime_pay),0) ot, COUNT(DISTINCT r.employee_id) people ${PAYROLL_FROM} WHERE ${w}`, a);
}

async function financials(f, fromDate, toDate) {
  const params = [fromDate, toDate];
  let cat = "";
  if (f.category) { cat = "AND (a.account_type = 'revenue' OR a.id = (SELECT default_account_id FROM transaction_categories WHERE id = ?))"; params.push(f.category); }
  return select(
    `SELECT DATE_FORMAT(j.entry_date,'%Y-%m') AS ym, a.account_type, a.code, MAX(a.name) AS name, SUM(l.debit) AS d, SUM(l.credit) AS c FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.entry_id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE j.status IN ('posted','reversed') AND j.entry_date BETWEEN ? AND ? AND a.account_type IN ('revenue','expense') ${cat} GROUP BY ym, a.account_type, a.code`, params);
}

const change = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

export async function analytics(query) {
  const f = readFilters(query);
  const months = monthsBetween(f.from, f.to);
  const fromDate = `${f.from}-01`, toDate = lastDay(f.to);
  const len = months.length;
  const [py, pm] = f.from.split("-").map(Number);
  const prevStart = ym(new Date(py, pm - 1 - len, 1)), prevEnd = ym(new Date(py, pm - 2, 1));
  const prevFrom = `${prevStart}-01`, prevTo = lastDay(prevEnd);

  const [w, a] = payrollWhere(f, fromDate, toDate);
  const byMonth = await select(`SELECT DATE_FORMAT(p.end_date,'%Y-%m') ym, SUM(${PAYROLL_EXPENSE_SQL}) cost, SUM(r.gross_pay) gross, SUM(r.net_pay) net, SUM(r.employer_contributions) er, SUM(r.overtime_pay) ot ${PAYROLL_FROM} WHERE ${w} GROUP BY ym`, a);
  const pick = (key, col) => toCents(byMonth.find((r) => r.ym === key)?.[col] || 0);
  const series = (col) => months.map((m) => peso(pick(m, col)));
  const costs = months.map((m) => peso(pick(m, "cost")));

  // deductions
  const ded = await select(`SELECT c.code, c.category, SUM(d.amount) t FROM payroll_deductions d JOIN salary_components c ON c.id = d.component_id JOIN payroll_records r ON r.id = d.record_id JOIN payroll_periods p ON p.id = r.period_id JOIN employees e ON e.id = r.employee_id WHERE ${w} GROUP BY c.code, c.category`, a);
  const dSum = (fn) => peso(ded.filter(fn).reduce((s, x) => s + toCents(x.t), 0));
  const deductions = [
    { name: "SSS", value: dSum((x) => x.code === "SSS") }, { name: "PhilHealth", value: dSum((x) => x.code === "PHILHEALTH") }, { name: "Pag-IBIG", value: dSum((x) => x.code === "PAGIBIG") },
    { name: "Withholding tax", value: dSum((x) => x.code === "WTAX") }, { name: "Absences & lateness", value: dSum((x) => x.category === "absence") }, { name: "Loans & other", value: dSum((x) => ["loan", "other_deduction"].includes(x.category)) },
  ];

  // salary distribution (monthly equivalent of current rates)
  const dpy = await getSetting("payroll.days_per_year", 313), hpd = await getSetting("attendance.hours_per_day", 8);
  const empW = ["e.deleted_at IS NULL", "e.employment_status IN ('active','on_leave')"], empA = [];
  if (f.department) { empW.push("e.department_id = ?"); empA.push(f.department); }
  if (f.employee) { empW.push("e.id = ?"); empA.push(f.employee); }
  const rates = await select(`SELECT e.basic_salary, e.rate_basis FROM employees e WHERE ${empW.join(" AND ")}`, empA);
  const BANDS = [["Under ₱10K", 0, 10000], ["₱10–15K", 10000, 15000], ["₱15–20K", 15000, 20000], ["₱20–30K", 20000, 30000], ["₱30–50K", 30000, 50000], ["₱50K+", 50000, Infinity]];
  const monthly = rates.map((e) => { const b = Number(e.basic_salary); return e.rate_basis === "monthly" ? b : e.rate_basis === "daily" ? (b * dpy) / 12 : (b * hpd * dpy) / 12; });
  const salaryDist = BANDS.map(([name, lo, hi]) => ({ name, value: monthly.filter((v) => v >= lo && v < hi).length }));

  // attendance patterns
  const [aw, ax] = attendanceWhere(f, fromDate, toDate);
  const attFrom = "FROM attendance_records a JOIN employees e ON e.id = a.employee_id";
  const weekday = await select(`SELECT WEEKDAY(a.work_date) d, SUM(a.status='late') late, SUM(a.status='absent') absent ${attFrom} WHERE ${aw} GROUP BY d`, ax);
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const byDept = await select(`SELECT dp.name, SUM(a.status='late') late, SUM(a.status='absent') absent ${attFrom} JOIN departments dp ON dp.id = e.department_id WHERE ${aw} GROUP BY dp.name ORDER BY dp.name`, ax);
  const attTotals = await selectOne(`SELECT COALESCE(SUM(a.status IN ('present','late','half_day')),0) worked, COALESCE(SUM(a.status='absent'),0) absent, COALESCE(SUM(a.status='late'),0) late ${attFrom} WHERE ${aw}`, ax);

  // financials
  const fin = await financials(f, fromDate, toDate);
  const finSum = (m, fn) => fin.filter((r) => r.ym === m && fn(r));
  const revenue = months.map((m) => peso(finSum(m, (r) => r.account_type === "revenue").reduce((s, r) => s + toCents(r.c) - toCents(r.d), 0)));
  const expenses = months.map((m) => peso(finSum(m, (r) => r.account_type === "expense").reduce((s, r) => s + toCents(r.d) - toCents(r.c), 0)));
  // part-to-whole by expense account; each account keeps its colour whatever the filters leave on screen
  const byAccount = new Map();
  for (const r of fin) {
    if (r.account_type !== "expense" || ["5010", "5020", "5030"].includes(r.code)) continue;
    const slot = OPEX_SLOTS[r.code] || 6;
    const entry = byAccount.get(slot) || { name: OPEX_SLOTS[r.code] ? r.name : "Other accounts", slot, cents: 0 };
    entry.cents += toCents(r.d) - toCents(r.c);
    byAccount.set(slot, entry);
  }
  const opexByAccount = [...byAccount.values()].filter((e) => e.cents > 0).sort((a, b) => a.slot - b.slot).map((e) => ({ name: e.name, slot: e.slot, value: peso(e.cents) }));
  const opex = months.map((m) => peso(finSum(m, (r) => r.account_type === "expense" && !["5010", "5020", "5030"].includes(r.code)).reduce((s, r) => s + toCents(r.d) - toCents(r.c), 0)));
  const netIncome = months.map((_, i) => Math.round((revenue[i] - expenses[i]) * 100) / 100);

  // compensation by department
  const comp = await select(`SELECT COALESCE(r.department_name,'—') department, COUNT(DISTINCT r.employee_id) employees, SUM(r.gross_pay) gross, SUM(r.net_pay) net, SUM(r.employer_contributions) employer ${PAYROLL_FROM} WHERE ${w} GROUP BY r.department_name ORDER BY department`, a);

  // forecast: complete months only (the current month is usually partial), independent of the date filter
  const now = new Date();
  const histEnd = new Date(now.getFullYear(), now.getMonth() - 1, 1), histStart = new Date(now.getFullYear(), now.getMonth() - 12, 1);
  const histKeys = monthsBetween(ym(histStart), ym(histEnd));
  const [hw, ha] = payrollWhere({ ...f, period: null }, `${ym(histStart)}-01`, lastDay(ym(histEnd)));
  const hist = await select(`SELECT DATE_FORMAT(p.end_date,'%Y-%m') ym, SUM(${PAYROLL_EXPENSE_SQL}) cost ${PAYROLL_FROM} WHERE ${hw} GROUP BY ym`, ha);
  const observed = histKeys.filter((k) => hist.some((h) => h.ym === k)).map((k) => ({ key: k, value: Number(hist.find((h) => h.ym === k).cost) }));
  const fit = linearForecast(observed.map((o) => o.value), 3);
  let forecast = null;
  if (fit) {
    const futureKeys = [0, 1, 2].map((i) => ym(new Date(now.getFullYear(), now.getMonth() + i, 1)));
    const round = (v) => Math.round(v * 100) / 100;
    forecast = {
      n: fit.n, slope: round(fit.slope), first: monthLabel(futureKeys[0]), last: monthLabel(futureKeys[2]),
      labels: [...observed.map((o) => monthLabel(o.key)), ...futureKeys.map(monthLabel)],
      actual: [...observed.map((o) => round(o.value)), null, null, null],
      projected: [...observed.slice(0, -1).map(() => null), round(observed[observed.length - 1].value), ...fit.points.map((p) => round(p.value))],
      rows: futureKeys.map((k, i) => ({ month: monthLabel(k), value: round(fit.points[i].value), lower: round(fit.points[i].lower), upper: round(fit.points[i].upper) })),
    };
  }

  // KPIs with change against the preceding period of equal length
  const cur = await payrollTotals(f, fromDate, toDate), prev = await payrollTotals(f, prevFrom, prevTo);
  const cost = toCents(cur.cost), prevCost = toCents(prev.cost);
  const tRevenue = Math.round(revenue.reduce((s, v) => s + v, 0) * 100) / 100, tNet = Math.round(netIncome.reduce((s, v) => s + v, 0) * 100) / 100;
  const prevFin = await financials(f, prevFrom, prevTo);
  const prevRevenue = peso(prevFin.filter((r) => r.account_type === "revenue").reduce((s, r) => s + toCents(r.c) - toCents(r.d), 0));
  const worked = Number(attTotals.worked), absent = Number(attTotals.absent);

  return {
    f, months: months.map(monthLabel), costs, gross: series("gross"), net: series("net"), ot: series("ot"), deductions, salaryDist,
    weekday: DAYS.map((d, i) => ({ d, late: Number(weekday.find((x) => x.d === i)?.late || 0), absent: Number(weekday.find((x) => x.d === i)?.absent || 0) })),
    byDept: byDept.map((r) => ({ name: r.name, late: Number(r.late), absent: Number(r.absent) })),
    revenue, expenses, opex, opexByAccount, netIncome, comp, forecast,
    kpis: {
      cost: fromCents(cost), costChange: change(cost, prevCost), people: Number(cur.people), avg: Number(cur.people) ? fromCents(cost / Number(cur.people)) : "0.00",
      otShare: toCents(cur.gross) ? Math.round((toCents(cur.ot) / toCents(cur.gross)) * 1000) / 10 : 0,
      attendance: worked + absent ? Math.round((worked / (worked + absent)) * 1000) / 10 : null, late: Number(attTotals.late), absent,
      revenue: tRevenue, revenueChange: change(tRevenue, prevRevenue), net: tNet,
    },
  };
}

export const filterOptions = async () => ({
  departments: await select("SELECT id, name FROM departments WHERE deleted_at IS NULL ORDER BY name"),
  employees: (await select("SELECT id, employee_no, first_name, middle_name, last_name, suffix FROM employees WHERE deleted_at IS NULL ORDER BY last_name")).map((e) => ({ id: e.id, label: `${fullName(e)} (${e.employee_no})` })),
  categories: await select("SELECT id, name FROM transaction_categories WHERE category_type = 'expense' AND is_active = 1 ORDER BY name"),
  periods: await select("SELECT id, label FROM payroll_periods ORDER BY end_date DESC LIMIT 36"),
  years: (await select("SELECT YEAR(end_date) y FROM payroll_periods UNION SELECT YEAR(entry_date) FROM journal_entries UNION SELECT YEAR(work_date) FROM attendance_records UNION SELECT YEAR(CURDATE()) ORDER BY y DESC")).map((r) => String(r.y)),
});

