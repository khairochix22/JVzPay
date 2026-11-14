// The company's payroll schedule (owner, 2026-11-13 — fixed, cannot be changed):
//   kinsenas  — the 1st to the 15th, paid on the 25th of the same month;
//   katapusan — the 16th to the end of the month, paid on the 10th of the next month.
// Only the Accounting Supervisor creates payroll periods. Semi-monthly periods always take the fixed dates; weekly or
// monthly pay (from an HR job offer) gets special periods for chosen departments or employees.
// Philippine practice applied: a payday on a weekend or a non-working holiday is released on the working day before;
// the 13th-month pay goes with the 1–15 December payroll, released no later than 24 December (PD 851).
// Each period has one payroll run. It is computed automatically once the cutoff has passed and before the payday;
// Payroll Staff recompute it after validating attendance and submit it; the supervisor approves, finalizes and releases.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { fullName } from "./employeeService.js";
import { createBatch, recomputeBatch } from "./payrollService.js";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const FIRST_HALF_PAYDAY = 25;  // fixed
export const SECOND_HALF_PAYDAY = 10; // fixed, of the next month
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const SYSTEM = { user: { id: null, full_name: "Payroll schedule", role_code: "system", employee_id: null, can: () => true }, ip: null, get: () => null };

/** The fixed dates of one half of a month (pure). half: 1 = kinsenas, 2 = katapusan. */
export function fixedHalf(year, month, half) {
  const last = new Date(year, month, 0).getDate();
  if (half === 1) return { start: iso(new Date(year, month - 1, 1)), end: iso(new Date(year, month - 1, 15)), pay: iso(new Date(year, month - 1, FIRST_HALF_PAYDAY)) };
  return { start: iso(new Date(year, month - 1, 16)), end: iso(new Date(year, month - 1, last)), pay: iso(new Date(year, month, SECOND_HALF_PAYDAY)) };
}

/** The day the money actually goes out: the payday, or the working day before it (pure; holidays = Set of dates). */
export function releaseDateFor(payDate, holidays, deadline = null) {
  const d = parse(payDate);
  if (deadline && iso(d) > deadline) d.setTime(parse(deadline).getTime());
  while (d.getDay() === 0 || d.getDay() === 6 || holidays.has(iso(d))) d.setDate(d.getDate() - 1);
  return iso(d);
}

async function holidaySet(from, to, trx) {
  const rows = await select("SELECT holiday_date FROM holidays WHERE is_active = 1 AND holiday_type IN ('regular','special_non_working') AND holiday_date BETWEEN ? AND ?", [from, to], trx);
  return new Set(rows.map((h) => String(h.holiday_date).slice(0, 10)));
}

const label = (start, end) => {
  const a = parse(start), b = parse(end);
  return a.getMonth() === b.getMonth() ? `${MONTHS[a.getMonth()]} ${a.getDate()}–${b.getDate()}, ${b.getFullYear()}`
    : `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
};

/** Creates the two fixed semi-monthly periods of a month (YYYY-MM) that do not exist yet. */
export async function createFixedMonth(req, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw badRequest("Choose the month.");
  const [y, m] = month.split("-").map(Number);
  return tx(async (trx) => {
    const made = [];
    for (const half of [1, 2]) {
      const f = fixedHalf(y, m, half);
      if (await selectOne("SELECT id FROM payroll_periods WHERE pay_frequency = 'semi_monthly' AND start_date = ? AND end_date = ? AND scope_key = 'all'", [f.start, f.end], trx)) continue;
      const thirteenth = m === 12 && half === 1 ? 1 : 0;
      const release = releaseDateFor(f.pay, await holidaySet(iso(new Date(y, m - 1, 1)), f.pay, trx), thirteenth ? `${y}-12-24` : null);
      const code = `SM-${f.start}`;
      const { insertId } = await exec(
        `INSERT INTO payroll_periods (code, label, pay_frequency, cutoff, scope_key, start_date, end_date, pay_date, release_date, include_thirteenth, created_by)
         VALUES (?,?, 'semi_monthly', ?, 'all', ?,?,?,?,?,?)`,
        [code, `${label(f.start, f.end)} (${half === 1 ? "kinsenas" : "katapusan"})`, half === 1 ? "first_half" : "second_half", f.start, f.end, f.pay, release, thirteenth, req.user.id ?? null], trx);
      await audit(req, { action: "payroll_period_created", module: "payroll", recordType: "payroll_period", recordId: insertId, next: { code, start: f.start, end: f.end, pay_date: f.pay, release_date: release, thirteenth: !!thirteenth } }, trx);
      made.push(code);
    }
    return made;
  });
}

/** The current and the next month's fixed periods always exist (run by the scheduler and when the Payroll page opens). */
export async function ensureUpcoming() {
  const t = parse(today());
  for (const d of [t, new Date(t.getFullYear(), t.getMonth() + 1, 1)]) {
    await createFixedMonth(SYSTEM, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
}

/** A special period (weekly or monthly pay from an HR job offer) for a department or chosen employees. */
export function checkSpecial(body) {
  const v = {
    pay_frequency: String(body.pay_frequency || ""), start_date: String(body.start_date || ""), end_date: String(body.end_date || ""), pay_date: String(body.pay_date || ""),
    department_id: Number(body.department_id) || null,
    employee_ids: [...new Set([].concat(body.employee_ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))],
    include_thirteenth: body.include_thirteenth === "1" ? 1 : 0,
  };
  const errors = {};
  if (!["weekly", "monthly"].includes(v.pay_frequency)) errors.pay_frequency = "Special periods are weekly or monthly; semi-monthly pay always uses the fixed dates.";
  for (const k of ["start_date", "end_date", "pay_date"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(v[k])) errors[k] = "Enter the date.";
  if (!errors.start_date && !errors.end_date && v.end_date < v.start_date) errors.end_date = "The end cannot be before the start.";
  if (!errors.pay_date && !errors.end_date && v.pay_date < v.end_date) errors.pay_date = "The payday cannot be before the end of the period.";
  if (!v.department_id && !v.employee_ids.length) errors.scope = "Choose the department or the employees this period is for.";
  if (v.department_id && v.employee_ids.length) errors.scope = "Choose either a department or employees, not both.";
  return { values: v, errors };
}

export async function createSpecial(req, v) {
  return tx(async (trx) => {
    let names;
    if (v.department_id) {
      const d = await selectOne("SELECT id, name FROM departments WHERE id = ?", [v.department_id], trx);
      if (!d) throw badRequest("Department not found.");
      const n = Number(await scalar("SELECT COUNT(*) FROM employees WHERE department_id = ? AND pay_frequency = ? AND deleted_at IS NULL AND employment_status IN ('active','on_leave')", [d.id, v.pay_frequency], trx));
      if (!n) throw badRequest(`No active ${d.name} employee is paid ${v.pay_frequency} (HR sets each employee's pay frequency).`);
      names = d.name;
    } else {
      const emps = await select("SELECT id, first_name, middle_name, last_name, suffix, pay_frequency FROM employees WHERE id IN (?)", [v.employee_ids], trx);
      const wrong = emps.filter((e) => e.pay_frequency !== v.pay_frequency);
      if (emps.length !== v.employee_ids.length) throw badRequest("An employee was not found.");
      if (wrong.length) throw badRequest(`${wrong.map(fullName).join(", ")} ${wrong.length === 1 ? "is" : "are"} not paid ${v.pay_frequency} (HR sets each employee's pay frequency).`);
      names = emps.map(fullName).join(", ");
    }
    const scope = v.department_id ? `d:${v.department_id}` : `e:${v.employee_ids.slice().sort((a, b) => a - b).join(",")}`.slice(0, 60);
    const overlap = await scalar("SELECT COUNT(*) FROM payroll_periods WHERE pay_frequency = ? AND scope_key = ? AND start_date <= ? AND end_date >= ?", [v.pay_frequency, scope, v.end_date, v.start_date], trx);
    if (Number(overlap)) throw badRequest("This period overlaps another one for the same employees.");
    const release = releaseDateFor(v.pay_date, await holidaySet(v.start_date, v.pay_date, trx), v.include_thirteenth ? `${v.pay_date.slice(0, 4)}-12-24` : null);
    const code = `${v.pay_frequency === "weekly" ? "WK" : "MO"}-${v.start_date}-${v.department_id ? `D${v.department_id}` : `E${v.employee_ids[0]}`}`.slice(0, 40);
    const { insertId } = await exec(
      `INSERT INTO payroll_periods (code, label, pay_frequency, cutoff, department_id, scope_key, start_date, end_date, pay_date, release_date, include_thirteenth, created_by)
       VALUES (?,?,?, 'special', ?,?,?,?,?,?,?,?)`,
      [code, `${label(v.start_date, v.end_date)} · ${names}`.slice(0, 120), v.pay_frequency, v.department_id, scope, v.start_date, v.end_date, v.pay_date, release, v.include_thirteenth, req.user.id], trx);
    for (const id of v.employee_ids) await exec("INSERT INTO payroll_period_employees (period_id, employee_id) VALUES (?,?)", [insertId, id], trx);
    await audit(req, { action: "payroll_period_created", module: "payroll", recordType: "payroll_period", recordId: insertId, next: { code, ...v, release_date: release } }, trx);
    return { code, release };
  });
}

/** The Payroll page: every period with its run. */
export async function overview(filter = "") {
  const rows = await select(
    `SELECT p.*, d.name AS department,
            (SELECT COUNT(*) FROM payroll_period_employees x WHERE x.period_id = p.id) AS chosen,
            b.id AS batch_id, b.batch_no, b.status AS run_status, b.employee_count, b.total_gross, b.total_net, b.total_deductions
       FROM payroll_periods p LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN payroll_batches b ON b.id = (SELECT b2.id FROM payroll_batches b2 WHERE b2.period_id = p.id AND b2.status <> 'voided' ORDER BY b2.id DESC LIMIT 1)
      ${filter === "special" ? "WHERE p.cutoff = 'special'" : filter === "semi_monthly" ? "WHERE p.cutoff <> 'special'" : ""}
      ORDER BY p.start_date DESC, p.id DESC LIMIT 60`);
  const t = today();
  return rows.map((p) => ({
    ...p,
    current: String(p.start_date).slice(0, 10) <= t && String(p.end_date).slice(0, 10) >= t,
    cutoffPassed: String(p.end_date).slice(0, 10) < t,
    released: p.run_status === "released",
    moved: p.release_date && String(p.release_date).slice(0, 10) !== String(p.pay_date).slice(0, 10),
    scopeLabel: p.department ? `${p.department} (${p.pay_frequency})` : String(p.scope_key).startsWith("e:") ? `${p.chosen} chosen employee(s) (${p.pay_frequency})` : `All ${p.pay_frequency.replace("_", "-")} employees`,
  }));
}

/** Computes a period's run: creates it the first time, recomputes it while it is a draft. */
export async function computePeriod(req, periodId) {
  const p = await selectOne("SELECT * FROM payroll_periods WHERE id = ?", [periodId]);
  if (!p) throw notFound("Payroll period not found.");
  const run = await selectOne("SELECT id, status, batch_no FROM payroll_batches WHERE period_id = ? AND status <> 'voided' ORDER BY id DESC LIMIT 1", [periodId]);
  try {
    let out;
    if (!run) { const b = await createBatch(req, { period_id: p.id }); out = { id: b.id, no: b.batchNo, count: b.count, created: true }; }
    else if (run.status === "draft") { const n = await recomputeBatch(req, run.id); out = { id: run.id, no: run.batch_no, count: n, created: false }; }
    else throw badRequest(`The payroll of ${p.label} is already ${run.status.replace("_", " ")}.`);
    await exec("UPDATE payroll_periods SET compute_error = NULL WHERE id = ?", [p.id]);
    return out;
  } catch (e) {
    await exec("UPDATE payroll_periods SET compute_error = ? WHERE id = ?", [String(e.message).slice(0, 500), p.id]);
    throw e;
  }
}

/** Scheduler: compute every open period whose cutoff has passed and whose payday has not come yet, if it has no run. */
export async function autoCompute() {
  await ensureUpcoming();
  const due = await select(
    `SELECT p.id FROM payroll_periods p WHERE p.status = 'open' AND p.end_date < ? AND COALESCE(p.release_date, p.pay_date) >= ?
        AND NOT EXISTS (SELECT 1 FROM payroll_batches b WHERE b.period_id = p.id AND b.status <> 'voided')`, [today(), today()]);
  for (const p of due) { try { await computePeriod(SYSTEM, p.id); } catch { /* the reason is kept on the period and shown on the Payroll page */ } }
  return due.length;
}
