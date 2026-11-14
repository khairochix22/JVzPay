// Payroll batches (Module 3): Draft → For Review → Approved → Finalized → Released → (Voided through an authorised reversal).
// Each stage change is one database transaction with an append-only decision row, audit entry and notifications.
import crypto from "crypto";
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notify, notifyEmployee, notifyPermission } from "../lib/notify.js";
import { nextDocNo } from "../lib/sequence.js";
import { getSetting } from "../lib/settings.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { toCents, fromCents } from "../lib/money.js";
import { computeEmployeePayroll, PayrollConfigError } from "./payrollEngine.js";
import { postEntry, reverseEntry } from "./journalService.js";
import { fullName } from "./employeeService.js";
import { daysOffBetween } from "./scheduleService.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

export async function payrollSettings() {
  const g = (k, d) => getSetting(k, d);
  return {
    days_per_year: await g("payroll.days_per_year", 261), hours_per_day: await g("attendance.hours_per_day", 8), rest_day: await g("attendance.rest_day", 0), rest_day_2: await g("attendance.rest_day_2", ""),
    contribution_schedule: await g("payroll.contribution_schedule", "split"),
    ot_multiplier_regular: await g("payroll.ot_multiplier_regular", 1.25), ot_multiplier_rest_day: await g("payroll.ot_multiplier_rest_day", 1.69), ot_multiplier_holiday: await g("payroll.ot_multiplier_holiday", 2.6),
    holiday_multiplier_regular: await g("payroll.holiday_multiplier_regular", 2), holiday_multiplier_special: await g("payroll.holiday_multiplier_special", 1.3),
    night_diff_rate: await g("payroll.night_diff_rate", 0.1),
    rest_day_multiplier: await g("payroll.rest_day_multiplier", 1.3), bonus_tax_exempt_ceiling: await g("payroll.bonus_tax_exempt_ceiling", 90000),
    holiday_multiplier_regular_rest_day: await g("payroll.holiday_multiplier_regular_rest_day", 2.6), holiday_multiplier_special_rest_day: await g("payroll.holiday_multiplier_special_rest_day", 1.5),
  };
}

/** The statutory rules and tax table effective on the period's end date. Unverified data is refused unless explicitly allowed. */
export async function loadStatutory(endDate, trx = null) {
  const rules = {};
  for (const agency of ["SSS", "PHILHEALTH", "PAGIBIG"]) {
    const rule = await selectOne(
      "SELECT * FROM statutory_contribution_rules WHERE agency = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1",
      [agency, endDate, endDate], trx);
    if (!rule) throw badRequest(`No ${agency} contribution rule is effective on ${endDate}. Add one under Statutory Rules.`);
    rules[agency] = rule;
  }
  const eff = await scalar("SELECT MAX(effective_from) FROM withholding_tax_brackets WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)", [endDate, endDate], trx);
  if (!eff) throw badRequest(`No withholding tax table is effective on ${endDate}. Add one under Tax Table.`);
  const brackets = await select("SELECT * FROM withholding_tax_brackets WHERE effective_from = ? ORDER BY annual_from", [eff], trx);
  const unverified = [...Object.values(rules).filter((r) => !r.is_verified).map((r) => r.agency), ...(brackets.some((b) => !b.is_verified) ? ["Withholding tax table"] : [])];
  if (unverified.length && !(await getSetting("payroll.allow_unverified_rules", false))) {
    throw badRequest(`Payroll cannot run on unverified statutory data: ${unverified.join(", ")}. An Accounting Supervisor must check them against current issuances and mark them verified (Payroll Setup → Statutory Rules / Tax Table).`);
  }
  return { rules, brackets, unverified };
}

const eligibleSql = `e.deleted_at IS NULL AND e.pay_frequency = ? AND e.date_hired <= ?
  AND (e.employment_status IN ('active','on_leave') OR e.date_separated BETWEEN ? AND ?)
  AND (e.date_separated IS NULL OR e.date_separated >= ?)`;
const eligibleParams = (p) => [p.pay_frequency, p.end_date, p.start_date, p.end_date, p.start_date];
// a special period covers one department or chosen employees; a fixed semi-monthly period covers everyone paid semi-monthly
// (a period whose scope is "all" — the fixed ones, or one made before scopes existed — covers everyone of that frequency)
const chosen = (p) => String(p.scope_key || "").startsWith("e:");
const scopeSql = (p) => (p.department_id ? " AND e.department_id = ?" : chosen(p) ? " AND e.id IN (SELECT employee_id FROM payroll_period_employees WHERE period_id = ?)" : "");
const scopeParams = (p) => (p.department_id ? [p.department_id] : chosen(p) ? [p.id] : []);

export async function eligibleCount(period) {
  return Number(await scalar(
    `SELECT COUNT(*) FROM employees e WHERE ${eligibleSql}${scopeSql(period)}
       AND NOT EXISTS (SELECT 1 FROM payroll_records r WHERE r.employee_id = e.id AND r.period_id = ? AND r.active_flag = 1)`,
    [...eligibleParams(period), ...scopeParams(period), period.id]));
}

async function computeInto(batch, period, departmentId, trx) {
  const statutory = await loadStatutory(period.end_date, trx);
  const settings = await payrollSettings();
  const holidays = await select("SELECT holiday_date, name, holiday_type FROM holidays WHERE is_active = 1 AND holiday_date BETWEEN ? AND ?", [period.start_date, period.end_date], trx);
  const components = new Map((await select("SELECT id, code FROM salary_components", [], trx)).map((c) => [c.code, c.id]));
  const employees = await select(
    `SELECT e.*, d.name AS department, p.title AS position FROM employees e JOIN departments d ON d.id = e.department_id JOIN positions p ON p.id = e.position_id
      WHERE ${eligibleSql}${scopeSql(period)} ${departmentId ? "AND e.department_id = ?" : ""}
        AND NOT EXISTS (SELECT 1 FROM payroll_records r WHERE r.employee_id = e.id AND r.period_id = ? AND r.active_flag = 1)
      ORDER BY e.last_name, e.first_name`,
    [...eligibleParams(period), ...scopeParams(period), ...(departmentId ? [departmentId] : []), period.id], trx);
  if (!employees.length) throw badRequest("No employees are eligible: everyone with this pay frequency already has payroll in this period, or none is active.");
  // HR is the source of truth: payroll runs only on employees whose record came from HR (master prompt §XVI)
  const notSynced = employees.filter((e) => !e.hr_employee_id);
  if (notSynced.length) throw badRequest(`Payroll needs HR-synchronised records. Not yet received from HR: ${notSynced.slice(0, 5).map((e) => `${fullName(e)} (${e.employee_no})`).join(", ")}${notSynced.length > 5 ? ` and ${notSynced.length - 5} more` : ""}. See System → Integration.`);

  const totals = { gross: 0, ded: 0, net: 0, er: 0 };
  for (const e of employees) {
    const [attendance, leaves, overtime, payItems, adjustments, leaveConversions, retirementRow, daysOff, ytd, ytdBasic] = await Promise.all([
      select("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date BETWEEN ? AND ?", [e.id, period.start_date, period.end_date], trx),
      select(`SELECT l.start_date, l.end_date, l.days, t.is_paid, t.code FROM leave_applications l JOIN leave_types t ON t.id = l.leave_type_id
               WHERE l.employee_id = ? AND l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?`, [e.id, period.end_date, period.start_date], trx),
      select("SELECT id, work_date, hours, ot_type FROM overtime_records WHERE employee_id = ? AND status = 'approved' AND payroll_record_id IS NULL AND work_date BETWEEN ? AND ?", [e.id, period.start_date, period.end_date], trx),
      select(`SELECT i.id, i.amount, i.remaining_balance, i.description, c.code AS component_code, c.name AS component_name, c.component_type, c.category, c.is_taxable
                FROM employee_pay_items i JOIN salary_components c ON c.id = i.component_id
               WHERE i.employee_id = ? AND i.status = 'approved' AND i.effective_from <= ? AND (i.effective_to IS NULL OR i.effective_to >= ?)
                 AND (i.remaining_balance IS NULL OR i.remaining_balance > 0)`, [e.id, period.end_date, period.start_date], trx),
      select(`SELECT a.id, a.adjustment_no, a.adjustment_type, a.amount, a.reason, c.code AS component_code, c.is_taxable, c.category
                FROM payroll_adjustments a JOIN salary_components c ON c.id = a.component_id
               WHERE a.employee_id = ? AND a.period_id = ? AND a.status = 'approved'`, [e.id, period.id], trx),
      // approved vacation leave conversions are paid in the first payroll computed after approval
      select("SELECT id, conversion_no, year, days, daily_rate, amount FROM leave_conversions WHERE employee_id = ? AND status = 'approved' AND payroll_record_id IS NULL", [e.id], trx),
      selectOne("SELECT id, rate_percent FROM retirement_enrollments WHERE employee_id = ? AND active_flag = 1 AND effective_from <= ?", [e.id, period.end_date], trx),
      daysOffBetween(e.id, period.start_date, period.end_date, trx),
      // bonuses already paid this calendar year, for the ₱90,000 exemption
      selectOne(`SELECT COALESCE(SUM(pe.amount), 0) AS total FROM payroll_earnings pe JOIN salary_components c ON c.id = pe.component_id
                   JOIN payroll_records r ON r.id = pe.record_id JOIN payroll_periods pp ON pp.id = r.period_id
                  WHERE r.employee_id = ? AND r.active_flag = 1 AND c.category IN ('bonus','incentive') AND YEAR(pp.end_date) = YEAR(?)`, [e.id, period.end_date], trx),
      // 13th-month pay (PD 851): basic salary actually earned this year, before this period
      period.include_thirteenth ? selectOne(`SELECT COALESCE(SUM(r.basic_pay - (SELECT COALESCE(SUM(d.amount), 0) FROM payroll_deductions d JOIN salary_components c ON c.id = d.component_id
                   WHERE d.record_id = r.id AND c.category = 'absence')), 0) AS total
                   FROM payroll_records r JOIN payroll_periods pp ON pp.id = r.period_id
                  WHERE r.employee_id = ? AND r.active_flag = 1 AND YEAR(pp.end_date) = YEAR(?) AND pp.end_date < ?`, [e.id, period.end_date, period.start_date], trx) : null,
    ]);
    const retirement = retirementRow ? { rate_percent: retirementRow.rate_percent, enrollment_id: retirementRow.id } : null;
    // pay uses the rate effective on the period's end date, not whatever the current rate happens to be
    const rate = await selectOne(
      `SELECT new_amount, rate_basis FROM salary_history WHERE employee_id = ? AND verification_status <> 'rejected' AND effective_date <= ?
        ORDER BY effective_date DESC, id DESC LIMIT 1`, [e.id, period.end_date], trx);
    if (!rate || Number(rate.new_amount) <= 0) {
      throw badRequest(`${fullName(e)} has no positive HR-approved compensation effective by ${period.end_date}. Payroll cannot process this employee until HR sends EmployeeCompensationApproved.`);
    }
    const employee = rate ? { ...e, basic_salary: rate.new_amount, rate_basis: rate.rate_basis } : e;
    let out;
    try {
      out = computeEmployeePayroll({ employee, period, settings, attendance, holidays, leaves, overtime, payItems, adjustments, leaveConversions, retirement, daysOff, ytdBonuses: ytd.total, thirteenth: ytdBasic ? { ytdBasic: ytdBasic.total } : null, rules: statutory.rules, brackets: statutory.brackets });
    } catch (err) {
      if (err instanceof PayrollConfigError) throw badRequest(`${fullName(e)}: ${err.message}`);
      throw err;
    }
    if (statutory.unverified.length) out.warnings.unshift(`Computed with UNVERIFIED statutory data: ${statutory.unverified.join(", ")}.`);
    const r = out.record;
    const { insertId: recordId } = await exec(
      `INSERT INTO payroll_records (batch_id, period_id, employee_id, employee_no, employee_name, department_name, position_title, rate_basis, rate_amount,
         days_worked, days_absent, late_minutes, undertime_minutes, overbreak_minutes, overtime_hours, basic_pay, overtime_pay, holiday_pay, night_diff_pay, allowances, other_earnings,
         gross_pay, statutory_employee, withholding_tax, other_deductions, total_deductions, net_pay, employer_contributions, retirement_company_share, computation_notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [batch.id, period.id, e.id, e.employee_no, fullName(e), e.department, e.position, r.rate_basis, r.rate_amount,
       r.days_worked, r.days_absent, r.late_minutes, r.undertime_minutes, r.overbreak_minutes, r.overtime_hours, r.basic_pay, r.overtime_pay, r.holiday_pay, r.night_diff_pay, r.allowances, r.other_earnings,
       r.gross_pay, r.statutory_employee, r.withholding_tax, r.other_deductions, r.total_deductions, r.net_pay, r.employer_contributions, r.retirement_company_share,
       JSON.stringify({ notes: out.notes, warnings: out.warnings })], trx);
    for (const l of out.earnings) {
      await exec("INSERT INTO payroll_earnings (record_id, component_id, description, quantity, rate, amount, source_type, source_id) VALUES (?,?,?,?,?,?,?,?)",
        [recordId, components.get(l.code), l.description.slice(0, 200), l.quantity ?? 1, l.rate ?? 0, l.amount, l.source_type ?? null, l.source_id ?? null], trx);
    }
    for (const l of out.deductions) {
      await exec("INSERT INTO payroll_deductions (record_id, component_id, description, amount, source_type, source_id) VALUES (?,?,?,?,?,?)",
        [recordId, components.get(l.code), l.description.slice(0, 200), l.amount, l.source_type ?? null, l.source_id ?? null], trx);
    }
    for (const c of out.contributions) {
      await exec("INSERT INTO payroll_contributions (record_id, agency, rule_id, base_amount, employee_share, employer_share, ec_share) VALUES (?,?,?,?,?,?,?)",
        [recordId, c.agency, c.rule_id, c.base_amount, c.employee_share, c.employer_share, c.ec_share], trx);
    }
    totals.gross += out.totals.grossC; totals.ded += out.totals.totalDedC; totals.net += out.totals.netC; totals.er += out.totals.erTotal;
  }
  await exec(
    `UPDATE payroll_batches SET employee_count = ?, total_gross = ?, total_deductions = ?, total_net = ?, total_employer_contributions = ?, rules_snapshot = ? WHERE id = ?`,
    [employees.length, fromCents(totals.gross), fromCents(totals.ded), fromCents(totals.net), fromCents(totals.er),
     JSON.stringify({ rules: Object.fromEntries(Object.entries(statutory.rules).map(([k, v]) => [k, v.id])), tax_effective_from: statutory.brackets[0].effective_from, settings, computed_at: new Date().toISOString() }), batch.id], trx);
  return employees.length;
}

const lockPeriod = async (id, trx) => {
  const p = await selectOne("SELECT * FROM payroll_periods WHERE id = ? FOR UPDATE", [id], trx);
  if (!p) throw notFound("Payroll period not found.");
  if (p.status !== "open") throw badRequest(`Payroll period ${p.label} is ${p.status}.`);
  return p;
};
async function lockBatch(id, trx) {
  const b = await selectOne("SELECT * FROM payroll_batches WHERE id = ? FOR UPDATE", [id], trx);
  if (!b) throw notFound("Payroll batch not found.");
  return b;
}
const logStage = (batchId, action, req, remarks, trx) =>
  exec("INSERT INTO payroll_approvals (batch_id, action, actor_id, actor_role, remarks) VALUES (?,?,?,?,?)", [batchId, action, req.user.id, req.user.role_code, remarks || null], trx);
const setRecords = (batchId, status, trx) => exec("UPDATE payroll_records SET status = ? WHERE batch_id = ? AND active_flag = 1", [status, batchId], trx);

export async function createBatch(req, { period_id, department_id, remarks }) {
  return tx(async (trx) => {
    const period = await lockPeriod(period_id, trx);
    const batchNo = await nextDocNo("PB", 4, trx);
    const { insertId } = await exec("INSERT INTO payroll_batches (batch_no, period_id, department_id, prepared_by, remarks) VALUES (?,?,?,?,?)",
      [batchNo, period.id, department_id || null, req.user.id, remarks || null], trx);
    const count = await computeInto({ id: insertId }, period, department_id, trx);
    await audit(req, { action: "payroll_batch_created", module: "payroll", recordType: "payroll_batch", recordId: insertId, next: { batch_no: batchNo, period: period.code, employees: count } }, trx);
    return { id: insertId, batchNo, count };
  });
}

async function clearDraftRecords(batchId, trx) {
  const recs = await select("SELECT id FROM payroll_records WHERE batch_id = ?", [batchId], trx);
  if (!recs.length) return;
  const ids = recs.map((r) => r.id);
  await exec("DELETE FROM payroll_earnings WHERE record_id IN (?)", [ids], trx);
  await exec("DELETE FROM payroll_deductions WHERE record_id IN (?)", [ids], trx);
  await exec("DELETE FROM payroll_contributions WHERE record_id IN (?)", [ids], trx);
  await exec("DELETE FROM payroll_records WHERE id IN (?)", [ids], trx);
}

export async function recomputeBatch(req, id) {
  return tx(async (trx) => {
    const b = await lockBatch(id, trx);
    if (b.status !== "draft") throw badRequest("Only draft batches can be recomputed.");
    const period = await lockPeriod(b.period_id, trx);
    await clearDraftRecords(id, trx);
    const count = await computeInto(b, period, b.department_id, trx);
    await audit(req, { action: "payroll_batch_recomputed", module: "payroll", recordType: "payroll_batch", recordId: id, next: { employees: count } }, trx);
    return count;
  });
}

export async function deleteDraftBatch(req, id) {
  return tx(async (trx) => {
    const b = await lockBatch(id, trx);
    if (b.status !== "draft") throw badRequest("Only draft batches can be deleted.");
    if (await scalar("SELECT COUNT(*) FROM payroll_approvals WHERE batch_id = ?", [id], trx)) throw badRequest("This batch has an approval history and cannot be deleted. Recompute and resubmit it instead.");
    await clearDraftRecords(id, trx);
    await exec("DELETE FROM payroll_batches WHERE id = ?", [id], trx);
    await audit(req, { action: "payroll_batch_deleted", module: "payroll", recordType: "payroll_batch", recordId: id, previous: { batch_no: b.batch_no } }, trx);
    return b;
  });
}

export async function submitBatch(req, id) {
  return tx(async (trx) => {
    const b = await lockBatch(id, trx);
    if (b.status !== "draft") throw badRequest("Only draft batches can be submitted.");
    const period = await selectOne("SELECT * FROM payroll_periods WHERE id = ?", [b.period_id], trx);
    const recs = await select("SELECT id, employee_id FROM payroll_records WHERE batch_id = ?", [id], trx);
    if (!recs.length) throw badRequest("This batch has no payroll records.");
    const empIds = recs.map((r) => r.employee_id);
    const pending = Number(await scalar("SELECT COUNT(*) FROM attendance_records WHERE employee_id IN (?) AND work_date BETWEEN ? AND ? AND validation_status = 'pending'", [empIds, period.start_date, period.end_date], trx));
    if (pending) throw badRequest(`${pending} attendance record(s) in this period are still pending validation. Validate them and recompute before submitting.`);
    const unverifiedSalary = Number(await scalar("SELECT COUNT(*) FROM salary_history WHERE employee_id IN (?) AND verification_status = 'pending' AND effective_date <= ?", [empIds, period.end_date], trx));
    if (unverifiedSalary) throw badRequest(`${unverifiedSalary} salary change(s) for employees in this batch await supervisor verification.`);
    await exec("UPDATE payroll_batches SET status = 'for_review', submitted_by = ?, submitted_at = NOW() WHERE id = ?", [req.user.id, id], trx);
    await setRecords(id, "for_review", trx);
    await logStage(id, "submitted", req, null, trx);
    await audit(req, { action: "payroll_batch_submitted", module: "payroll", recordType: "payroll_batch", recordId: id, next: { batch_no: b.batch_no, total_net: b.total_net } }, trx);
    await notifyPermission("payroll.approve", { type: "payroll_submitted", title: "Payroll batch awaiting approval", message: `${b.batch_no} for ${period.label}: ${b.employee_count} employee(s).`, relatedType: "payroll_batch", relatedId: id, link: `/payroll/batches/${id}` }, { excludeUserId: req.user.id }, trx);
    return b;
  });
}

/** A supervisor whose own pay is in the batch must explicitly acknowledge it; the acknowledgement is audited. */
export async function approverOwnRecord(req, batchId, trx = null) {
  if (!req.user.employee_id) return null;
  return selectOne("SELECT id, net_pay FROM payroll_records WHERE batch_id = ? AND employee_id = ? AND active_flag = 1", [batchId, req.user.employee_id], trx);
}

export async function approveBatch(req, id, { remarks, acknowledgeOwn }) {
  return tx(async (trx) => {
    const b = await lockBatch(id, trx);
    if (b.status !== "for_review") throw badRequest("Only batches awaiting review can be approved.");
    if (b.prepared_by === req.user.id || b.submitted_by === req.user.id) throw forbidden("You cannot approve a payroll batch you prepared or submitted.");
    const own = await approverOwnRecord(req, id, trx);
    if (own && !acknowledgeOwn) throw badRequest("This batch includes your own payroll record. Tick the acknowledgement to confirm you reviewed it; the approval is flagged in the audit log.");
    await exec("UPDATE payroll_batches SET status = 'approved', approved_by = ?, approved_at = NOW(), last_rejection_reason = NULL WHERE id = ?", [req.user.id, id], trx);
    await setRecords(id, "approved", trx);
    const note = [remarks, own ? "Approver's own payroll record acknowledged" : null].filter(Boolean).join(" — ");
    await logStage(id, "approved", req, note, trx);
    await audit(req, { action: "payroll_batch_approved", module: "payroll", recordType: "payroll_batch", recordId: id, decision: "approved", remarks: note || null, next: { batch_no: b.batch_no, approver_own_record: !!own } }, trx);
    await notify(b.prepared_by, { type: "payroll_approved", title: "Payroll batch approved", message: `${b.batch_no} was approved.`, relatedType: "payroll_batch", relatedId: id, link: `/payroll/batches/${id}` }, trx);
    return b;
  });
}

export async function rejectBatch(req, id, reason) {
  if (!reason) throw badRequest("A reason is required when rejecting a payroll batch.");
  return tx(async (trx) => {
    const b = await lockBatch(id, trx);
    if (b.status !== "for_review") throw badRequest("Only batches awaiting review can be rejected.");
    if (b.prepared_by === req.user.id || b.submitted_by === req.user.id) throw forbidden("You cannot reject a payroll batch you prepared or submitted.");
    await exec("UPDATE payroll_batches SET status = 'draft', last_rejection_reason = ?, submitted_by = NULL, submitted_at = NULL WHERE id = ?", [reason, id], trx);
    await setRecords(id, "draft", trx);
    await logStage(id, "rejected", req, reason, trx);
    await audit(req, { action: "payroll_batch_rejected", module: "payroll", recordType: "payroll_batch", recordId: id, decision: "rejected", remarks: reason, next: { batch_no: b.batch_no } }, trx);
    await notify(b.prepared_by, { type: "payroll_rejected", title: "Payroll batch rejected", message: `${b.batch_no}: ${reason}`, relatedType: "payroll_batch", relatedId: id, link: `/payroll/batches/${id}` }, trx);
    return b;
  });
}

// Accrual journal: expense recognised on finalize; liabilities carry employee and employer shares separately.
async function accrualLines(batchId, trx) {
  const recs = await selectOne(
    `SELECT COALESCE(SUM(gross_pay),0) AS gross, COALESCE(SUM(overtime_pay),0) AS ot, COALESCE(SUM(net_pay),0) AS net, COALESCE(SUM(withholding_tax),0) AS tax,
            COALESCE(SUM(employer_contributions),0) AS er, COALESCE(SUM(retirement_company_share),0) AS ret_er FROM payroll_records WHERE batch_id = ? AND active_flag = 1`, [batchId], trx);
  const ded = await select(
    `SELECT c.category, COALESCE(SUM(d.amount),0) AS total FROM payroll_deductions d JOIN salary_components c ON c.id = d.component_id
       JOIN payroll_records r ON r.id = d.record_id WHERE r.batch_id = ? AND r.active_flag = 1 GROUP BY c.category`, [batchId], trx);
  const contr = await select(
    `SELECT agency, COALESCE(SUM(employee_share + employer_share + ec_share),0) AS total FROM payroll_contributions pc
       JOIN payroll_records r ON r.id = pc.record_id WHERE r.batch_id = ? AND r.active_flag = 1 GROUP BY agency`, [batchId], trx);
  const cat = (c) => toCents(ded.find((d) => d.category === c)?.total || 0);
  const agency = (a) => toCents(contr.find((c) => c.agency === a)?.total || 0);
  const known = ["statutory", "tax", "absence", "loan", "retirement"];
  const other = ded.filter((d) => !known.includes(d.category)).reduce((s, d) => s + toCents(d.total), 0);
  const gross = toCents(recs.gross), ot = toCents(recs.ot), absence = cat("absence");
  return [
    { account: "5010", debit: gross - ot - absence, description: "Salaries and wages earned (net of absences)" },
    { account: "5020", debit: ot, description: "Overtime" },
    { account: "5030", debit: toCents(recs.er), description: "Employer contributions" },
    { account: "2100", credit: toCents(recs.net), description: "Net pay owed to employees" },
    { account: "2210", credit: agency("SSS"), description: "SSS employee + employer + EC" },
    { account: "2220", credit: agency("PHILHEALTH"), description: "PhilHealth employee + employer" },
    { account: "2230", credit: agency("PAGIBIG"), description: "Pag-IBIG employee + employer" },
    { account: "2240", credit: toCents(recs.tax), description: "Withholding tax on compensation" },
    { account: "1100", credit: cat("loan"), description: "Employee loans and advances recovered" },
    { account: "2010", credit: other, description: "Other authorised deductions held for remittance" },
    { account: "5060", debit: toCents(recs.ret_er), description: "Retirement fund — company share" },
    { account: "2250", credit: cat("retirement") + toCents(recs.ret_er), description: "Retirement fund — employee and company shares" },
  ];
}

export async function finalizeBatch(req, id) {
  return tx(async (trx) => {
    const b = await lockBatch(id, trx);
    if (b.status !== "approved") throw badRequest("Payroll cannot be finalized without supervisor approval.");
    const period = await selectOne("SELECT * FROM payroll_periods WHERE id = ?", [b.period_id], trx);
    const recs = await select("SELECT * FROM payroll_records WHERE batch_id = ? AND active_flag = 1 FOR UPDATE", [id], trx);

    await exec("UPDATE payroll_batches SET status = 'finalized', finalized_by = ?, finalized_at = NOW() WHERE id = ?", [req.user.id, id], trx);
    await setRecords(id, "finalized", trx);
    for (const r of recs) {
      await exec(
        `UPDATE attendance_records SET validation_status = 'locked', locked_batch_id = ? WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND validation_status = 'validated'`,
        [id, r.employee_id, period.start_date, period.end_date], trx);
      const earn = await select("SELECT source_type, source_id FROM payroll_earnings WHERE record_id = ? AND source_id IS NOT NULL", [r.id], trx);
      const ded = await select("SELECT source_type, source_id, amount FROM payroll_deductions WHERE record_id = ? AND source_id IS NOT NULL", [r.id], trx);
      for (const l of earn) {
        if (l.source_type === "overtime") await exec("UPDATE overtime_records SET payroll_record_id = ? WHERE id = ?", [r.id, l.source_id], trx);
        if (l.source_type === "adjustment") await exec("UPDATE payroll_adjustments SET status = 'applied', applied_record_id = ? WHERE id = ?", [r.id, l.source_id], trx);
        if (l.source_type === "leave_conversion") await exec("UPDATE leave_conversions SET status = 'paid', payroll_record_id = ? WHERE id = ?", [r.id, l.source_id], trx);
      }
      for (const l of ded) {
        if (l.source_type === "retirement") {
          const enr = await selectOne("SELECT rate_percent FROM retirement_enrollments WHERE id = ?", [l.source_id], trx);
          await exec(`INSERT INTO retirement_contributions (employee_id, enrollment_id, payroll_record_id, period_id, rate_percent, employee_share, company_share, contribution_date)
                      VALUES (?,?,?,?,?,?,?,?)`, [r.employee_id, l.source_id, r.id, period.id, enr?.rate_percent || 0, l.amount, r.retirement_company_share, period.end_date], trx);
        }
        if (l.source_type === "adjustment") await exec("UPDATE payroll_adjustments SET status = 'applied', applied_record_id = ? WHERE id = ?", [r.id, l.source_id], trx);
        if (l.source_type === "pay_item") {
          const it = await selectOne("SELECT remaining_balance FROM employee_pay_items WHERE id = ? FOR UPDATE", [l.source_id], trx);
          if (it && it.remaining_balance !== null) {
            const left = Math.max(0, toCents(it.remaining_balance) - toCents(l.amount));
            await exec("UPDATE employee_pay_items SET remaining_balance = ?, status = ? WHERE id = ?", [fromCents(left), left === 0 ? "ended" : "approved", l.source_id], trx);
            // a salary loan whose balance reaches zero is paid; the employee may borrow again
            if (left === 0) await exec("UPDATE salary_loans SET status = 'paid', active_flag = NULL WHERE pay_item_id = ? AND status = 'released'", [l.source_id], trx);
          }
        }
      }
      const content = { record: r.id, employee: r.employee_no, period: period.code, gross: r.gross_pay, deductions: r.total_deductions, net: r.net_pay };
      const payslipNo = await nextDocNo("PS", 5, trx);
      await exec("INSERT INTO payslips (payslip_no, record_id, employee_id, content_hash, generated_by) VALUES (?,?,?,?,?)",
        [payslipNo, r.id, r.employee_id, crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex"), req.user.id], trx);
    }
    const je = await postEntry({ req, date: period.end_date, description: `Payroll accrual ${b.batch_no} (${period.label})`, sourceType: "payroll_batch", sourceId: id, sourceEvent: "accrual", lines: await accrualLines(id, trx) }, trx);
    await logStage(id, "finalized", req, je.entryNo, trx);
    await audit(req, { action: "payroll_batch_finalized", module: "payroll", recordType: "payroll_batch", recordId: id, next: { batch_no: b.batch_no, journal: je.entryNo, payslips: recs.length } }, trx);
    return b;
  });
}

export async function releaseBatch(req, id) {
  return tx(async (trx) => {
    const b = await lockBatch(id, trx);
    if (b.status !== "finalized") throw badRequest("Only finalized payroll can be released.");
    const period = await selectOne("SELECT * FROM payroll_periods WHERE id = ?", [b.period_id], trx);
    // pay goes out on the release date (the payday, or the working day before it); the bank can be funded the day before
    const releaseOn = String(period.release_date || period.pay_date || "").slice(0, 10);
    if (releaseOn) { const earliest = new Date(`${releaseOn}T00:00:00`); earliest.setDate(earliest.getDate() - 1);
      const e = `${earliest.getFullYear()}-${String(earliest.getMonth() + 1).padStart(2, "0")}-${String(earliest.getDate()).padStart(2, "0")}`;
      if (today() < e) throw badRequest(`${period.label} is paid on ${releaseOn}; it can be released from ${e}.`); }
    const recs = await select(
      `SELECT r.id, r.employee_id, r.net_pay, (SELECT 1 FROM bank_accounts a WHERE a.employee_id = r.employee_id AND a.active_flag = 1 LIMIT 1) AS has_bank
         FROM payroll_records r WHERE r.batch_id = ? AND r.active_flag = 1`, [id], trx);
    await exec("UPDATE payroll_batches SET status = 'released', released_by = ?, released_at = NOW() WHERE id = ?", [req.user.id, id], trx);
    await setRecords(id, "released", trx);
    await exec(`UPDATE payslips s JOIN payroll_records r ON r.id = s.record_id SET s.status = 'released', s.released_at = NOW() WHERE r.batch_id = ?`, [id], trx);
    const total = recs.reduce((a, r) => a + toCents(r.net_pay), 0);
    const bank = recs.filter((r) => r.has_bank).reduce((a, r) => a + toCents(r.net_pay), 0);
    const je = await postEntry({
      req, date: today(), description: `Payroll disbursement ${b.batch_no} (${period.label})`, sourceType: "payroll_batch", sourceId: id, sourceEvent: "disbursement",
      lines: [
        { account: "2100", debit: total, description: "Net pay paid" },
        { account: "1020", credit: bank, description: "Paid to enrolled bank accounts" },
        { account: "1010", credit: total - bank, description: "Paid in cash (no enrolled bank account)" },
      ],
    }, trx);
    await logStage(id, "released", req, je.entryNo, trx);
    await audit(req, { action: "payroll_batch_released", module: "payroll", recordType: "payroll_batch", recordId: id, next: { batch_no: b.batch_no, journal: je.entryNo } }, trx);
    for (const r of recs) {
      await notifyEmployee(r.employee_id, { type: "payslip_released", title: "Your payslip is available", message: `Payroll for ${period.label} has been released.`, relatedType: "payroll_record", relatedId: r.id, link: "/my/payslips" }, trx);
    }
    return b;
  });
}

/** Authorised correction path: reverses journals, unlocks attendance and overtime, restores loans, frees the period for re-processing. */
export async function voidBatch(req, id, reason) {
  if (!reason) throw badRequest("A reason is required to void a payroll batch.");
  return tx(async (trx) => {
    const b = await lockBatch(id, trx);
    if (!["approved", "finalized", "released"].includes(b.status)) throw badRequest("Only approved, finalized or released payroll can be voided.");
    const recs = await select("SELECT * FROM payroll_records WHERE batch_id = ? AND active_flag = 1 FOR UPDATE", [id], trx);
    const entries = await select("SELECT id FROM journal_entries WHERE source_type = 'payroll_batch' AND source_id = ? AND status = 'posted' ORDER BY id DESC", [id], trx);
    for (const e of entries) await reverseEntry(req, e.id, `Payroll ${b.batch_no} voided: ${reason}`, trx);
    if (b.status !== "approved") {
      await exec("UPDATE attendance_records SET validation_status = 'validated', locked_batch_id = NULL WHERE locked_batch_id = ?", [id], trx);
      for (const r of recs) {
        await exec("UPDATE overtime_records SET payroll_record_id = NULL WHERE payroll_record_id = ?", [r.id], trx);
        await exec("UPDATE leave_conversions SET status = 'approved', payroll_record_id = NULL WHERE payroll_record_id = ?", [r.id], trx);
        if (Number(await scalar("SELECT COUNT(*) FROM retirement_contributions WHERE payroll_record_id = ? AND withdrawal_id IS NOT NULL", [r.id], trx)))
          throw badRequest(`${r.employee_name}'s retirement contribution from this payroll was already withdrawn; it cannot be voided.`);
        await exec("DELETE FROM retirement_contributions WHERE payroll_record_id = ?", [r.id], trx);
        await exec("UPDATE payroll_adjustments SET status = 'approved', applied_record_id = NULL WHERE applied_record_id = ?", [r.id], trx);
        const ded = await select("SELECT source_id, amount FROM payroll_deductions WHERE record_id = ? AND source_type = 'pay_item'", [r.id], trx);
        for (const l of ded) {
          const it = await selectOne("SELECT remaining_balance FROM employee_pay_items WHERE id = ? FOR UPDATE", [l.source_id], trx);
          if (it && it.remaining_balance !== null) await exec("UPDATE employee_pay_items SET remaining_balance = ?, status = 'approved' WHERE id = ?", [fromCents(toCents(it.remaining_balance) + toCents(l.amount)), l.source_id], trx);
          // a voided payroll reopens a salary loan it had paid off
          await exec("UPDATE salary_loans SET status = 'released', active_flag = 1 WHERE pay_item_id = ? AND status = 'paid'", [l.source_id], trx);
        }
        if (b.status === "released") await notifyEmployee(r.employee_id, { type: "payroll_voided", title: "A released payroll was voided", message: `Payroll ${b.batch_no} was voided and will be corrected. Reason: ${reason}`, relatedType: "payroll_record", relatedId: r.id }, trx);
      }
    }
    await exec("UPDATE payroll_batches SET status = 'voided', voided_by = ?, voided_at = NOW(), void_reason = ? WHERE id = ?", [req.user.id, reason, id], trx);
    await exec("UPDATE payroll_records SET status = 'voided', active_flag = NULL WHERE batch_id = ? AND active_flag = 1", [id], trx);
    await logStage(id, "voided", req, reason, trx);
    await audit(req, { action: "payroll_batch_voided", module: "payroll", recordType: "payroll_batch", recordId: id, remarks: reason, previous: { status: b.status }, next: { batch_no: b.batch_no, journals_reversed: entries.length } }, trx);
    return b;
  });
}

// ---- read models ---------------------------------------------------------------------------------------------------------------
export async function listBatches(req) {
  const t = tableState(req, { sortable: { created: "b.id", net: "b.total_net", status: "b.status" }, defaultSort: "created", defaultDir: "desc" });
  const status = ["draft", "for_review", "approved", "finalized", "released", "voided"].includes(req.query.status) ? req.query.status : null;
  const where = []; const params = [];
  if (status) { where.push("b.status = ?"); params.push(status); }
  if (t.q) { where.push("(b.batch_no LIKE ? OR p.label LIKE ?)"); const l = likeTerm(t.q); params.push(l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM payroll_batches b JOIN payroll_periods p ON p.id = b.period_id ${W}`, params));
  const rows = await select(
    `SELECT b.*, p.label AS period_label, p.start_date, p.end_date, d.name AS department, u.full_name AS prepared_by_name
       FROM payroll_batches b JOIN payroll_periods p ON p.id = b.period_id LEFT JOIN departments d ON d.id = b.department_id JOIN users u ON u.id = b.prepared_by
       ${W} ORDER BY ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows, t, status, meta: tableMeta(req, t, total, { status: status || undefined }) };
}

export async function getBatch(id) {
  const b = await selectOne(
    `SELECT b.*, p.label AS period_label, p.code AS period_code, p.start_date, p.end_date, p.pay_date, p.release_date, p.pay_frequency, d.name AS department,
            u.full_name AS prepared_by_name, a.full_name AS approved_by_name, f.full_name AS finalized_by_name, x.full_name AS released_by_name, v.full_name AS voided_by_name
       FROM payroll_batches b JOIN payroll_periods p ON p.id = b.period_id LEFT JOIN departments d ON d.id = b.department_id
       JOIN users u ON u.id = b.prepared_by LEFT JOIN users a ON a.id = b.approved_by LEFT JOIN users f ON f.id = b.finalized_by
       LEFT JOIN users x ON x.id = b.released_by LEFT JOIN users v ON v.id = b.voided_by WHERE b.id = ?`, [id]);
  if (!b) throw notFound("Payroll batch not found.");
  const records = await select("SELECT * FROM payroll_records WHERE batch_id = ? ORDER BY employee_name", [id]);
  const warnings = [];
  for (const r of records) {
    const n = typeof r.computation_notes === "string" ? JSON.parse(r.computation_notes) : r.computation_notes;
    for (const w of n?.warnings || []) warnings.push({ employee: r.employee_name, text: w });
  }
  const [history, journals, pendingAttendance] = await Promise.all([
    select("SELECT a.*, u.full_name FROM payroll_approvals a JOIN users u ON u.id = a.actor_id WHERE a.batch_id = ? ORDER BY a.id", [id]),
    select("SELECT id, entry_no, entry_date, description, status, total_debit, source_event FROM journal_entries WHERE source_type = 'payroll_batch' AND source_id = ? ORDER BY id", [id]),
    records.length ? scalar("SELECT COUNT(*) FROM attendance_records WHERE employee_id IN (?) AND work_date BETWEEN ? AND ? AND validation_status = 'pending'", [records.map((r) => r.employee_id), b.start_date, b.end_date]) : 0,
  ]);
  return { ...b, records, warnings, history, journals, pendingAttendance: Number(pendingAttendance) };
}

export async function getRecord(id) {
  const r = await selectOne(
    `SELECT r.*, b.batch_no, b.status AS batch_status, p.label AS period_label, p.start_date, p.end_date
       FROM payroll_records r JOIN payroll_batches b ON b.id = r.batch_id JOIN payroll_periods p ON p.id = r.period_id WHERE r.id = ?`, [id]);
  if (!r) throw notFound("Payroll record not found.");
  const [earnings, deductions, contributions] = await Promise.all([
    select("SELECT * FROM payroll_earnings WHERE record_id = ? ORDER BY id", [id]),
    select("SELECT * FROM payroll_deductions WHERE record_id = ? ORDER BY id", [id]),
    select("SELECT * FROM payroll_contributions WHERE record_id = ? ORDER BY FIELD(agency,'SSS','PHILHEALTH','PAGIBIG')", [id]),
  ]);
  const notes = typeof r.computation_notes === "string" ? JSON.parse(r.computation_notes) : r.computation_notes;
  return { ...r, earnings, deductions, contributions, notes: notes?.notes || [], warnings: notes?.warnings || [] };
}
