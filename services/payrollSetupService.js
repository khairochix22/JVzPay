// Payroll setup and supporting transactions: periods, recurring pay items/loans, one-off adjustments, statutory rules,
// tax tables, holidays, salary components and supervisor verification of salary changes.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { notifyEmployee, notifyPermission } from "../lib/notify.js";
import { nextDocNo } from "../lib/sequence.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { fullName } from "./employeeService.js";
import { Holiday, SalaryComponent } from "../models/index.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };

// ---- periods ----------------------------------------------------------------------------------------------------------------
export function periodLabel(start, end) {
  const a = parse(start), b = parse(end);
  return a.getMonth() === b.getMonth()
    ? `${MONTHS[a.getMonth()]} ${a.getDate()}–${b.getDate()}, ${b.getFullYear()}`
    : `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
}

/** Next period after the latest one of that frequency (semi-monthly 1–15 / 16–end; monthly; weekly Mon–Sun). */
export async function suggestNextPeriod(frequency) {
  const last = await selectOne("SELECT end_date FROM payroll_periods WHERE pay_frequency = ? ORDER BY end_date DESC LIMIT 1", [frequency]);
  const now = new Date();
  let start;
  if (last) start = parse(addDays(last.end_date, 1));
  else if (frequency === "weekly") { start = new Date(now); start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); }
  else if (frequency === "semi_monthly") start = new Date(now.getFullYear(), now.getMonth(), now.getDate() <= 15 ? 1 : 16);
  else start = new Date(now.getFullYear(), now.getMonth(), 1);
  let end;
  if (frequency === "weekly") { end = new Date(start); end.setDate(start.getDate() + 6); }
  else if (frequency === "monthly") end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  else end = start.getDate() <= 15 ? new Date(start.getFullYear(), start.getMonth(), 15) : new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const pay = new Date(end); pay.setDate(end.getDate() + 5);
  return { pay_frequency: frequency, start_date: iso(start), end_date: iso(end), pay_date: iso(pay) };
}

export async function listPeriods(req) {
  const t = tableState(req, { sortable: { start: "p.start_date", status: "p.status" }, defaultSort: "start", defaultDir: "desc" });
  const status = ["open", "locked", "closed"].includes(req.query.status) ? req.query.status : "";
  const where = [], params = [];
  if (status) { where.push("p.status = ?"); params.push(status); }
  if (t.q) { where.push("(p.label LIKE ? OR p.code LIKE ?)"); params.push(likeTerm(t.q), likeTerm(t.q)); }
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM payroll_periods p ${W}`, params));
  const rows = await select(
    `SELECT p.*, (SELECT COUNT(*) FROM payroll_batches b WHERE b.period_id = p.id AND b.status <> 'voided') AS batches,
            (SELECT COUNT(*) FROM payroll_batches b WHERE b.period_id = p.id AND b.status IN ('draft','for_review','approved')) AS in_progress
       FROM payroll_periods p ${W} ORDER BY ${t.orderBy}, p.id DESC LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows, t, status, meta: tableMeta(req, t, total, { status }) };
}

export const openPeriods = () => select("SELECT id, code, label, pay_frequency, start_date, end_date FROM payroll_periods WHERE status = 'open' ORDER BY start_date DESC");

export async function createPeriod(req, v) {
  if (v.end_date < v.start_date) throw badRequest("The end date cannot be before the start date.");
  if (v.pay_date && v.pay_date < v.end_date) throw badRequest("The pay date cannot be before the end of the period.");
  return tx(async (trx) => {
    const overlap = await scalar("SELECT COUNT(*) FROM payroll_periods WHERE pay_frequency = ? AND start_date <= ? AND end_date >= ?", [v.pay_frequency, v.end_date, v.start_date], trx);
    if (Number(overlap)) throw badRequest("This period overlaps an existing period with the same pay frequency.");
    const prefix = { weekly: "WK", semi_monthly: "SM", monthly: "MO" }[v.pay_frequency];
    const code = `${prefix}-${v.start_date}`;
    const { insertId } = await exec("INSERT INTO payroll_periods (code, label, pay_frequency, start_date, end_date, pay_date, created_by) VALUES (?,?,?,?,?,?,?)",
      [code, periodLabel(v.start_date, v.end_date), v.pay_frequency, v.start_date, v.end_date, v.pay_date, req.user.id], trx);
    await audit(req, { action: "payroll_period_created", module: "payroll", recordType: "payroll_period", recordId: insertId, next: { code, ...v } }, trx);
    return { id: insertId, code };
  });
}

export async function setPeriodStatus(req, id, status) {
  return tx(async (trx) => {
    const p = await selectOne("SELECT * FROM payroll_periods WHERE id = ? FOR UPDATE", [id], trx);
    if (!p) throw notFound("Payroll period not found.");
    if (status === "closed") {
      const open = await scalar("SELECT COUNT(*) FROM payroll_batches WHERE period_id = ? AND status IN ('draft','for_review','approved')", [id], trx);
      if (Number(open)) throw badRequest("Finish or delete the batches still in progress before closing this period.");
    }
    await exec("UPDATE payroll_periods SET status = ? WHERE id = ?", [status, id], trx);
    await audit(req, { action: `payroll_period_${status === "closed" ? "closed" : "reopened"}`, module: "payroll", recordType: "payroll_period", recordId: id, previous: { status: p.status }, next: { status } }, trx);
    return p;
  });
}

// ---- recurring pay items (allowances, loans, deductions) -----------------------------------------------------------------------
export async function listPayItems(req, { defaultStatus = null } = {}) {
  const t = tableState(req, { sortable: { employee: "e.last_name", from: "i.effective_from", status: "i.status" }, defaultSort: "from", defaultDir: "desc" });
  const status = ["pending", "approved", "rejected", "ended"].includes(req.query.status) ? req.query.status : req.query.status === "all" ? null : defaultStatus;
  const where = []; const params = [];
  if (status) { where.push("i.status = ?"); params.push(status); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM employee_pay_items i JOIN employees e ON e.id = i.employee_id ${W}`, params));
  const rows = await select(
    `SELECT i.*, c.name AS component_name, c.component_type, c.category, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, s.full_name AS submitted_by_name, x.full_name AS decided_by_name
       FROM employee_pay_items i JOIN salary_components c ON c.id = i.component_id JOIN employees e ON e.id = i.employee_id
       LEFT JOIN users s ON s.id = i.submitted_by LEFT JOIN users x ON x.id = i.decided_by
       ${W} ORDER BY ${t.orderBy}, i.id DESC LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows: rows.map((r) => ({ ...r, name: fullName(r), own: r.employee_id === req.user.employee_id || r.submitted_by === req.user.id })), t, status: status || "all", meta: tableMeta(req, t, total, { status: status || "all" }) };
}

const USER_CATEGORIES = ["allowance", "incentive", "bonus", "other_earning", "loan", "other_deduction"];
export const payItemComponents = () => select(`SELECT id, code, name, component_type, category FROM salary_components WHERE is_active = 1 AND category IN (?) ORDER BY component_type, name`, [USER_CATEGORIES]);

export async function createPayItem(req, v) {
  const comp = await selectOne("SELECT * FROM salary_components WHERE id = ? AND is_active = 1", [v.component_id]);
  if (!comp || !USER_CATEGORIES.includes(comp.category)) throw badRequest("Select a valid pay component.");
  if (comp.category === "loan" && !v.remaining_balance) throw badRequest("Enter the total loan or advance amount to be recovered.");
  if (v.effective_to && v.effective_to < v.effective_from) throw badRequest("The end date cannot be before the start date.");
  const emp = await selectOne("SELECT id, first_name, middle_name, last_name, suffix FROM employees WHERE id = ? AND deleted_at IS NULL", [v.employee_id]);
  if (!emp) throw badRequest("Employee not found.");
  if (emp.id === req.user.employee_id) throw forbidden("You cannot encode pay items for yourself.");
  return tx(async (trx) => {
    const { insertId } = await exec(
      "INSERT INTO employee_pay_items (employee_id, component_id, description, amount, remaining_balance, effective_from, effective_to, submitted_by) VALUES (?,?,?,?,?,?,?,?)",
      [emp.id, comp.id, v.description, v.amount, comp.category === "loan" ? v.remaining_balance : null, v.effective_from, v.effective_to, req.user.id], trx);
    await audit(req, { action: "pay_item_submitted", module: "payroll", recordType: "pay_item", recordId: insertId, next: { employee_id: emp.id, component: comp.code, amount: v.amount } }, trx);
    await notifyPermission("payitems.approve", { type: "pay_item_submitted", title: "Pay item awaiting approval", message: `${comp.name} of ₱${v.amount} per period for ${fullName(emp)}.`, relatedType: "pay_item", relatedId: insertId, link: "/payroll/pay-items/review" }, { excludeUserId: req.user.id }, trx);
    return insertId;
  });
}

export async function decidePayItem(req, id, action, remarks) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting.");
  return tx(async (trx) => {
    const i = await selectOne("SELECT * FROM employee_pay_items WHERE id = ? FOR UPDATE", [id], trx);
    if (!i) throw notFound("Pay item not found.");
    if (i.status !== "pending") throw badRequest(`This item was already ${i.status}.`);
    if (i.submitted_by === req.user.id || i.employee_id === req.user.employee_id) throw forbidden("You cannot decide on a pay item you encoded or your own.");
    await exec("UPDATE employee_pay_items SET status = ?, decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [action, req.user.id, remarks || null, id], trx);
    await audit(req, { action: `pay_item_${action}`, module: "payroll", recordType: "pay_item", recordId: id, decision: action, remarks, next: { amount: i.amount } }, trx);
    return i;
  });
}

export async function endPayItem(req, id) {
  const i = await selectOne("SELECT * FROM employee_pay_items WHERE id = ?", [id]);
  if (!i || i.status !== "approved") throw badRequest("Only approved items can be ended.");
  await exec("UPDATE employee_pay_items SET status = 'ended', effective_to = CURDATE() WHERE id = ?", [id]);
  await audit(req, { action: "pay_item_ended", module: "payroll", recordType: "pay_item", recordId: id });
}

// ---- one-off payroll adjustments ----------------------------------------------------------------------------------------------
export async function listAdjustments(req, { defaultStatus = null } = {}) {
  const t = tableState(req, { sortable: { submitted: "a.submitted_at", employee: "e.last_name" }, defaultSort: "submitted", defaultDir: "desc" });
  const status = ["pending", "approved", "rejected", "applied"].includes(req.query.status) ? req.query.status : req.query.status === "all" ? null : defaultStatus;
  const where = []; const params = [];
  if (status) { where.push("a.status = ?"); params.push(status); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR a.adjustment_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM payroll_adjustments a JOIN employees e ON e.id = a.employee_id ${W}`, params));
  const rows = await select(
    `SELECT a.*, c.name AS component_name, p.label AS period_label, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, s.full_name AS submitted_by_name, x.full_name AS decided_by_name
       FROM payroll_adjustments a JOIN salary_components c ON c.id = a.component_id JOIN payroll_periods p ON p.id = a.period_id JOIN employees e ON e.id = a.employee_id
       JOIN users s ON s.id = a.submitted_by LEFT JOIN users x ON x.id = a.decided_by
       ${W} ORDER BY ${t.orderBy}, a.id DESC LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows: rows.map((r) => ({ ...r, name: fullName(r), own: r.employee_id === req.user.employee_id || r.submitted_by === req.user.id })), t, status: status || "all", meta: tableMeta(req, t, total, { status: status || "all" }) };
}

export const adjustmentComponents = () => select("SELECT id, code, name, component_type FROM salary_components WHERE is_active = 1 AND category IN ('other_earning','incentive','bonus','allowance','other_deduction') ORDER BY component_type, name");

export async function createAdjustment(req, v) {
  const comp = await selectOne("SELECT * FROM salary_components WHERE id = ? AND is_active = 1", [v.component_id]);
  if (!comp) throw badRequest("Select a valid component.");
  const period = await selectOne("SELECT * FROM payroll_periods WHERE id = ? AND status = 'open'", [v.period_id]);
  if (!period) throw badRequest("Select an open payroll period.");
  const emp = await selectOne("SELECT id, first_name, middle_name, last_name, suffix FROM employees WHERE id = ? AND deleted_at IS NULL", [v.employee_id]);
  if (!emp) throw badRequest("Employee not found.");
  if (emp.id === req.user.employee_id) throw forbidden("You cannot file a payroll adjustment for yourself.");
  return tx(async (trx) => {
    const no = await nextDocNo("PADJ", 4, trx);
    const { insertId } = await exec(
      "INSERT INTO payroll_adjustments (adjustment_no, employee_id, period_id, adjustment_type, component_id, amount, reason, submitted_by) VALUES (?,?,?,?,?,?,?,?)",
      [no, emp.id, period.id, comp.component_type, comp.id, v.amount, v.reason, req.user.id], trx);
    await audit(req, { action: "payroll_adjustment_submitted", module: "payroll", recordType: "payroll_adjustment", recordId: insertId, next: { adjustment_no: no, type: comp.component_type, amount: v.amount, reason: v.reason } }, trx);
    await notifyPermission("payroll.adjust.approve", { type: "payroll_adjustment_submitted", title: "Payroll adjustment awaiting approval", message: `${no} for ${fullName(emp)}: ₱${v.amount}.`, relatedType: "payroll_adjustment", relatedId: insertId, link: "/payroll/adjustments/review" }, { excludeUserId: req.user.id }, trx);
    return no;
  });
}

export async function decideAdjustment(req, id, action, remarks) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting.");
  return tx(async (trx) => {
    const a = await selectOne("SELECT * FROM payroll_adjustments WHERE id = ? FOR UPDATE", [id], trx);
    if (!a) throw notFound("Adjustment not found.");
    if (a.status !== "pending") throw badRequest(`This adjustment was already ${a.status}.`);
    if (a.submitted_by === req.user.id || a.employee_id === req.user.employee_id) throw forbidden("You cannot decide on an adjustment you filed or your own.");
    await exec("UPDATE payroll_adjustments SET status = ?, decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?", [action, req.user.id, remarks || null, id], trx);
    await audit(req, { action: `payroll_adjustment_${action}`, module: "payroll", recordType: "payroll_adjustment", recordId: id, decision: action, remarks, next: { adjustment_no: a.adjustment_no, amount: a.amount } }, trx);
    return a;
  });
}

// ---- statutory rules ------------------------------------------------------------------------------------------------------------
export const listRules = () => select(`SELECT r.*, u.full_name AS verified_by_name FROM statutory_contribution_rules r LEFT JOIN users u ON u.id = r.verified_by ORDER BY FIELD(r.agency,'SSS','PHILHEALTH','PAGIBIG'), r.effective_from DESC`);

export async function verifyRule(req, id) {
  const r = await selectOne("SELECT * FROM statutory_contribution_rules WHERE id = ?", [id]);
  if (!r) throw notFound("Rule not found.");
  await exec("UPDATE statutory_contribution_rules SET is_verified = 1, verified_by = ?, verified_at = NOW() WHERE id = ?", [req.user.id, id]);
  await audit(req, { action: "statutory_rule_verified", module: "payroll", recordType: "statutory_rule", recordId: id, next: { agency: r.agency, effective_from: r.effective_from } });
  return r;
}

export async function addRule(req, v) {
  if (Number(v.salary_ceiling) < Number(v.salary_floor)) throw badRequest("The ceiling cannot be below the floor.");
  if ((Number(v.low_income_ceiling || 0) > 0) !== (Number(v.low_income_employee_rate_pct || 0) > 0)) throw badRequest("Give both the lower-band salary and its employee rate, or leave both empty.");
  return tx(async (trx) => {
    const dup = await scalar("SELECT COUNT(*) FROM statutory_contribution_rules WHERE agency = ? AND effective_from = ?", [v.agency, v.effective_from], trx);
    if (Number(dup)) throw badRequest("A rule for this agency and effective date already exists.");
    await exec("UPDATE statutory_contribution_rules SET effective_to = DATE_SUB(?, INTERVAL 1 DAY) WHERE agency = ? AND effective_from < ? AND effective_to IS NULL", [v.effective_from, v.agency, v.effective_from], trx);
    const { insertId } = await exec(
      `INSERT INTO statutory_contribution_rules (agency, effective_from, employee_rate, employer_rate, low_income_ceiling, low_income_employee_rate, salary_floor, salary_ceiling, rounding_step, ec_threshold, ec_amount_low, ec_amount_high, source_reference, notes, is_verified)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [v.agency, v.effective_from, Number(v.employee_rate_pct) / 100, Number(v.employer_rate_pct) / 100, v.low_income_ceiling || 0, Number(v.low_income_employee_rate_pct || 0) / 100, v.salary_floor, v.salary_ceiling, v.rounding_step || 0, v.ec_threshold || 0, v.ec_amount_low || 0, v.ec_amount_high || 0, v.source_reference, v.notes], trx);
    await audit(req, { action: "statutory_rule_added", module: "payroll", recordType: "statutory_rule", recordId: insertId, next: v }, trx);
    return insertId;
  });
}

// ---- tax table ----------------------------------------------------------------------------------------------------------------
export async function listTaxTables() {
  const rows = await select(`SELECT b.*, u.full_name AS verified_by_name FROM withholding_tax_brackets b LEFT JOIN users u ON u.id = b.verified_by ORDER BY b.effective_from DESC, b.annual_from`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.effective_from)) map.set(r.effective_from, { effective_from: r.effective_from, effective_to: r.effective_to, source_reference: r.source_reference, is_verified: !!r.is_verified, verified_by_name: r.verified_by_name, verified_at: r.verified_at, brackets: [] });
    map.get(r.effective_from).brackets.push(r);
  }
  return [...map.values()];
}

export async function verifyTaxTable(req, effectiveFrom) {
  const { affectedRows } = await exec("UPDATE withholding_tax_brackets SET is_verified = 1, verified_by = ?, verified_at = NOW() WHERE effective_from = ?", [req.user.id, effectiveFrom]);
  if (!affectedRows) throw notFound("Tax table not found.");
  await audit(req, { action: "tax_table_verified", module: "payroll", recordType: "tax_table", recordId: effectiveFrom });
}

/** rows = [{ annual_from, annual_to|null, base_tax, rate_pct }] sorted and contiguous: each bracket starts where the last ended. */
export async function addTaxTable(req, effectiveFrom, sourceReference, rows) {
  if (rows.length < 2) throw badRequest("Enter at least two brackets.");
  for (let i = 0; i < rows.length; i++) {
    const to = rows[i].annual_to;
    if (i < rows.length - 1 && (to === null || Number(to) <= Number(rows[i].annual_from))) throw badRequest(`Bracket ${i + 1}: the upper limit must be above the lower limit.`);
    if (i < rows.length - 1 && Number(rows[i + 1].annual_from) !== Number(to)) throw badRequest(`Bracket ${i + 2} must start where bracket ${i + 1} ends.`);
    if (i === rows.length - 1 && to !== null) throw badRequest("The last bracket must have no upper limit.");
  }
  if (Number(rows[0].annual_from) !== 0) throw badRequest("The first bracket must start at 0.");
  return tx(async (trx) => {
    if (Number(await scalar("SELECT COUNT(*) FROM withholding_tax_brackets WHERE effective_from = ?", [effectiveFrom], trx))) throw badRequest("A tax table with this effective date already exists.");
    await exec("UPDATE withholding_tax_brackets SET effective_to = DATE_SUB(?, INTERVAL 1 DAY) WHERE effective_from < ? AND effective_to IS NULL", [effectiveFrom, effectiveFrom], trx);
    for (const r of rows) {
      await exec("INSERT INTO withholding_tax_brackets (effective_from, annual_from, annual_to, base_tax, rate, source_reference, is_verified) VALUES (?,?,?,?,?,?,0)",
        [effectiveFrom, r.annual_from, r.annual_to, r.base_tax, Number(r.rate_pct) / 100, sourceReference], trx);
    }
    await audit(req, { action: "tax_table_added", module: "payroll", recordType: "tax_table", recordId: effectiveFrom, next: { brackets: rows.length, source: sourceReference } }, trx);
  });
}

// ---- holidays (Holiday model) ---------------------------------------------------------------------------------------------------
export const listHolidays = (year) => select("SELECT * FROM holidays WHERE YEAR(holiday_date) = ? ORDER BY holiday_date", [year]);

export async function saveHoliday(req, id, v) {
  const dup = await Holiday.findOne({ where: { holiday_date: v.holiday_date }, raw: true });
  if (dup && dup.id !== id) throw badRequest("A holiday already exists on this date.");
  if (id) {
    const h = await Holiday.findByPk(id);
    if (!h) throw notFound("Holiday not found.");
    const prev = h.get({ plain: true });
    await h.update(v);
    await audit(req, { action: "holiday_updated", module: "payroll", recordType: "holiday", recordId: id, previous: prev, next: v });
    return id;
  }
  const h = await Holiday.create({ ...v, is_active: 1 });
  await audit(req, { action: "holiday_added", module: "payroll", recordType: "holiday", recordId: h.id, next: v });
  return h.id;
}

export async function toggleHoliday(req, id) {
  const h = await Holiday.findByPk(id);
  if (!h) throw notFound("Holiday not found.");
  await h.update({ is_active: !h.is_active });
  await audit(req, { action: h.is_active ? "holiday_activated" : "holiday_deactivated", module: "payroll", recordType: "holiday", recordId: id });
  return h;
}

// ---- salary components (SalaryComponent model) ------------------------------------------------------------------------------------
export const listComponents = () => SalaryComponent.findAll({ order: [["component_type", "ASC"], ["name", "ASC"]], raw: true });
export const COMPONENT_CATEGORIES = { earning: ["allowance", "incentive", "bonus", "other_earning"], deduction: ["loan", "other_deduction"] };

export async function addComponent(req, v) {
  const type = COMPONENT_CATEGORIES.earning.includes(v.category) ? "earning" : "deduction";
  const code = v.code.toUpperCase();
  if (await SalaryComponent.findOne({ where: { code }, raw: true })) throw badRequest("A component with this code already exists.");
  const c = await SalaryComponent.create({ code, name: v.name, component_type: type, category: v.category, is_taxable: type === "earning" ? v.is_taxable : 0, is_system: 0, is_active: 1 });
  await audit(req, { action: "salary_component_added", module: "payroll", recordType: "salary_component", recordId: c.id, next: { code, name: v.name, category: v.category } });
  return c;
}

export async function toggleComponent(req, id) {
  const c = await SalaryComponent.findByPk(id);
  if (!c) throw notFound("Component not found.");
  if (c.is_system) throw badRequest("System components are used by the payroll engine and cannot be deactivated.");
  await c.update({ is_active: !c.is_active });
  await audit(req, { action: c.is_active ? "salary_component_activated" : "salary_component_deactivated", module: "payroll", recordType: "salary_component", recordId: id });
  return c;
}

// ---- salary change verification --------------------------------------------------------------------------------------------------
export async function listSalaryChanges(req) {
  const t = tableState(req, { sortable: { recorded: "s.created_at", employee: "e.last_name" }, defaultSort: "recorded", defaultDir: "asc" });
  const status = ["pending", "verified", "rejected"].includes(req.query.status) ? req.query.status : req.query.status === "all" ? null : "pending";
  const where = []; const params = [];
  if (status) { where.push("s.verification_status = ?"); params.push(status); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM salary_history s JOIN employees e ON e.id = s.employee_id ${W}`, params));
  const rows = await select(
    `SELECT s.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, r.full_name AS recorded_by_name, v.full_name AS verified_by_name
       FROM salary_history s JOIN employees e ON e.id = s.employee_id LEFT JOIN users r ON r.id = s.recorded_by LEFT JOIN users v ON v.id = s.verified_by
       ${W} ORDER BY ${t.orderBy}, s.id LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows: rows.map((r) => ({ ...r, name: fullName(r), own: r.recorded_by === req.user.id || r.employee_id === req.user.employee_id })), t, status: status || "all", meta: tableMeta(req, t, total, { status: status || "all" }) };
}

/** Verifying clears the change for payroll. Rejecting restores the previous rate and leaves a new history row. */
export async function decideSalaryChange(req, id, action, remarks) {
  if (!["verified", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting a salary change.");
  return tx(async (trx) => {
    const s = await selectOne("SELECT * FROM salary_history WHERE id = ? FOR UPDATE", [id], trx);
    if (!s) throw notFound("Salary change not found.");
    if (s.verification_status !== "pending") throw badRequest(`This change was already ${s.verification_status}.`);
    if (s.recorded_by === req.user.id || s.employee_id === req.user.employee_id) throw forbidden("You cannot verify a salary change you recorded or your own.");
    await exec("UPDATE salary_history SET verification_status = ?, verified_by = ?, verified_at = NOW(), verification_remarks = ? WHERE id = ?", [action, req.user.id, remarks || null, id], trx);
    if (action === "rejected" && s.previous_amount !== null) {
      const latest = await selectOne("SELECT id FROM salary_history WHERE employee_id = ? ORDER BY id DESC LIMIT 1", [s.employee_id], trx);
      if (Number(latest.id) === Number(s.id)) {
        await exec("UPDATE employees SET basic_salary = ?, updated_by = ? WHERE id = ?", [s.previous_amount, req.user.id, s.employee_id], trx);
        await exec(
          `INSERT INTO salary_history (employee_id, previous_amount, new_amount, rate_basis, pay_frequency, effective_date, reason, verification_status, verified_by, verified_at, recorded_by)
           VALUES (?,?,?,?,?,CURDATE(),?,'verified',?,NOW(),?)`,
          [s.employee_id, s.new_amount, s.previous_amount, s.rate_basis, s.pay_frequency, `Reverted: ${remarks}`.slice(0, 255), req.user.id, req.user.id], trx);
      }
    }
    await audit(req, { action: `salary_change_${action}`, module: "payroll", recordType: "salary_history", recordId: id, decision: action === "verified" ? "approved" : "rejected", remarks, previous: { amount: s.previous_amount }, next: { amount: s.new_amount } }, trx);
    if (action === "rejected") await notifyEmployee(s.employee_id, { type: "salary_change_rejected", title: "Salary change reversed", message: "A recent change to your salary was not verified and has been reversed.", relatedType: "employee", relatedId: s.employee_id }, trx);
    return s;
  });
}
