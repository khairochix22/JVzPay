// Read-only REST API for the other JOHNVIVZ applications (docs/API_INTEGRATION.md §5).
// Each application reads only what its own department needs; the service token decides which. Nothing here writes
// business data: HR, CRM and Inventory still change JVzPay only through events (POST /api/v1/events).
// Dates are formatted in SQL (DATE_FORMAT) so a DATE never shifts a day when turned into JSON.
import { select, selectOne } from "../lib/db.js";
import { badRequest, notFound } from "../lib/errors.js";

const D = (col, alias) => `DATE_FORMAT(${col}, '%Y-%m-%d') AS ${alias || col.split(".").pop()}`;
const DT = (col, alias) => `DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s+08:00') AS ${alias || col.split(".").pop()}`;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !Number.isNaN(Date.parse(v));
const num = (v) => (v === null || v === undefined ? null : Number(v));
const MAX_RANGE_DAYS = 93;

/** Paging: ?limit= (1–500, default 100) and ?offset=. */
export function paging(q) {
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  return { limit, offset };
}

/** ?from=&to= (YYYY-MM-DD). Both default to the current month; the range may not exceed 93 days. */
function dateRange(q) {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // Philippine date
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const from = q.from || new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const to = q.to || new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  if (!isDate(from) || !isDate(to)) throw badRequest("from and to must be dates (YYYY-MM-DD).");
  if (from > to) throw badRequest("from must not be after to.");
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) throw badRequest(`The date range may not exceed ${MAX_RANGE_DAYS} days.`);
  return { from, to };
}

const oneOf = (v, list, label) => {
  if (v === undefined || v === "") return null;
  if (!list.includes(v)) throw badRequest(`${label} must be one of: ${list.join(", ")}.`);
  return v;
};

// ================================================= common ===================================================================

/** Status of an event this application sent (by its event_id). Another application's events are not visible. */
export async function inboundEventStatus(client, eventId) {
  const row = await selectOne(
    `SELECT event_id, event_type, entity_id, correlation_id, status, error, attempts, result_ref, ${DT("received_at")}, ${DT("processed_at")}
       FROM integration_inbox WHERE event_id = ? AND source = ?`, [String(eventId), client.source]);
  if (!row) throw notFound("No event with that event_id was received from your application.");
  return row;
}

const TARGET_OF = { johnvivz_hr: "hr", johnvivz_crm: "crm", johnvivz_inventory: "inventory" };

/**
 * Events JVzPay has for this application, oldest first, after a cursor (?after=<sequence>).
 * The same events are pushed to {APP}_API_URL when it is set; an application that cannot receive pushes yet can
 * poll this feed instead. Consumers de-duplicate by event_id either way.
 */
export async function outboundFeed(client, q) {
  const target = TARGET_OF[client.source];
  const after = Math.max(0, parseInt(q.after, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
  const type = q.event_type ? String(q.event_type).slice(0, 60) : null;
  const rows = await select(
    `SELECT id, payload, status FROM integration_outbox
      WHERE target = ? AND id > ? ${type ? "AND event_type = ?" : ""} ORDER BY id LIMIT ?`,
    type ? [target, after, type, limit] : [target, after, limit]);
  const events = rows.map((r) => ({ sequence: Number(r.id), delivery_status: r.status, ...(typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) }));
  return { events, next_after: events.length ? events[events.length - 1].sequence : after, has_more: events.length === limit };
}

// ================================================= HR =======================================================================

async function employeeByHrId(hrId) {
  const e = await selectOne("SELECT id, hr_employee_id, employee_no FROM employees WHERE hr_employee_id = ? AND deleted_at IS NULL", [String(hrId)]);
  if (!e) throw notFound(`JVzPay has no employee with HR id ${hrId}. Send EmployeeCreated first.`);
  return e;
}

const EMPLOYEE_COLS = `e.hr_employee_id AS employee_id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix,
  d.code AS department_code, d.name AS department_name, p.title AS position_title, e.employment_type, e.employment_status,
  ${D("e.date_hired")}, ${D("e.date_separated")}, e.supervisor_hr_id AS supervisor_employee_id, ${DT("e.hr_synced_at")},
  u.status AS account_status, ${DT("u.last_login_at")}`;
const EMPLOYEE_FROM = `FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN positions p ON p.id = e.position_id
  LEFT JOIN users u ON u.employee_id = e.id AND u.deleted_at IS NULL`;

/** JVzPay's copy of the employee master plus the Self-Service account state (to reconcile with HR). */
export async function hrEmployees(q) {
  const { limit, offset } = paging(q);
  const where = ["e.deleted_at IS NULL", "e.hr_employee_id IS NOT NULL"];
  const params = [];
  const status = oneOf(q.status, ["active", "on_leave", "suspended", "resigned", "terminated"], "status");
  if (status) { where.push("e.employment_status = ?"); params.push(status); }
  if (q.department_code) { where.push("d.code = ?"); params.push(String(q.department_code).toUpperCase()); }
  const rows = await select(`SELECT ${EMPLOYEE_COLS} ${EMPLOYEE_FROM} WHERE ${where.join(" AND ")} ORDER BY e.employee_no LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { employees: rows.map(withAccount), limit, offset };
}

export async function hrEmployee(hrId) {
  const row = await selectOne(`SELECT ${EMPLOYEE_COLS} ${EMPLOYEE_FROM} WHERE e.deleted_at IS NULL AND e.hr_employee_id = ?`, [String(hrId)]);
  if (!row) throw notFound(`JVzPay has no employee with HR id ${hrId}.`);
  return withAccount(row);
}

function withAccount(r) {
  const { account_status, last_login_at, ...rest } = r;
  return { ...rest, account: { registered: !!account_status, status: account_status || null, last_login_at: last_login_at || null } };
}

/** Official attendance (owned by Accounting/Payroll) for one employee or everyone, within a date range. */
export async function hrAttendance(q) {
  const { from, to } = dateRange(q);
  const { limit, offset } = paging(q);
  const params = [from, to];
  let extra = "";
  if (q.employee_id) { const e = await employeeByHrId(q.employee_id); extra = "AND a.employee_id = ?"; params.push(e.id); }
  const rows = await select(
    `SELECT e.hr_employee_id AS employee_id, e.employee_no, ${D("a.work_date")}, TIME_FORMAT(a.time_in, '%H:%i') AS time_in,
            TIME_FORMAT(a.time_out, '%H:%i') AS time_out, a.status, a.late_minutes, a.undertime_minutes, a.overbreak_minutes,
            a.hours_worked, a.source, a.validation_status, a.remarks
       FROM attendance_records a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ? ${extra} ORDER BY a.work_date, e.employee_no LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { from, to, records: rows.map((r) => ({ ...r, hours_worked: num(r.hours_worked) })), limit, offset };
}

/** Leave applications whose dates touch the range. */
export async function hrLeaveRequests(q) {
  const { from, to } = dateRange(q);
  const { limit, offset } = paging(q);
  const params = [to, from];
  let extra = "";
  if (q.employee_id) { const e = await employeeByHrId(q.employee_id); extra += " AND l.employee_id = ?"; params.push(e.id); }
  const status = oneOf(q.status, ["pending", "approved", "rejected", "cancelled"], "status");
  if (status) { extra += " AND l.status = ?"; params.push(status); }
  const rows = await select(
    `SELECT l.application_no AS request_no, e.hr_employee_id AS employee_id, e.employee_no, t.code AS leave_type_code, t.name AS leave_type_name,
            ${D("l.start_date")}, ${D("l.end_date")}, l.days, l.reason, l.status, l.supervisor_status, l.supervisor_name, l.routed_to,
            ${DT("l.submitted_at")}, l.approver_name, ${DT("l.decided_at")}, l.decision_remarks
       FROM leave_applications l JOIN employees e ON e.id = l.employee_id JOIN leave_types t ON t.id = l.leave_type_id
      WHERE l.start_date <= ? AND l.end_date >= ? ${extra} ORDER BY l.start_date, l.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { from, to, requests: rows.map((r) => ({ ...r, days: num(r.days) })), limit, offset };
}

/** Leave balances of one employee for a year (default: this year). */
export async function hrLeaveBalances(hrId, q) {
  const e = await employeeByHrId(hrId);
  const year = q.year ? parseInt(q.year, 10) : new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();
  if (!(year >= 2000 && year <= 2100)) throw badRequest("year must be a four-digit year.");
  const rows = await select(
    `SELECT t.code AS leave_type_code, t.name AS leave_type_name, b.entitled_days, b.adjusted_days, b.used_days, b.pending_days
       FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
      WHERE b.employee_id = ? AND b.year = ? ORDER BY t.code`, [e.id, year]);
  return {
    employee_id: e.hr_employee_id, employee_no: e.employee_no, year,
    balances: rows.map((r) => {
      const x = { leave_type_code: r.leave_type_code, leave_type_name: r.leave_type_name, entitled_days: num(r.entitled_days), adjusted_days: num(r.adjusted_days), used_days: num(r.used_days), pending_days: num(r.pending_days) };
      return { ...x, available_days: Math.round((x.entitled_days + x.adjusted_days - x.used_days - x.pending_days) * 10) / 10 };
    }),
  };
}

/** Overtime within a date range. */
export async function hrOvertime(q) {
  const { from, to } = dateRange(q);
  const { limit, offset } = paging(q);
  const params = [from, to];
  let extra = "";
  if (q.employee_id) { const e = await employeeByHrId(q.employee_id); extra += " AND o.employee_id = ?"; params.push(e.id); }
  const status = oneOf(q.status, ["pending", "approved", "rejected"], "status");
  if (status) { extra += " AND o.status = ?"; params.push(status); }
  const rows = await select(
    `SELECT o.request_no, e.hr_employee_id AS employee_id, e.employee_no, ${D("o.work_date")}, TIME_FORMAT(o.start_time, '%H:%i') AS start_time,
            TIME_FORMAT(o.end_time, '%H:%i') AS end_time, o.hours, o.ot_type, o.reason, o.source, o.status, o.supervisor_status, o.supervisor_name,
            o.routed_to, o.approver_name, ${DT("o.decided_at")}, o.decision_remarks
       FROM overtime_records o JOIN employees e ON e.id = o.employee_id
      WHERE o.work_date BETWEEN ? AND ? ${extra} ORDER BY o.work_date, o.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { from, to, overtime: rows.map((r) => ({ ...r, hours: num(r.hours) })), limit, offset };
}

/**
 * Requests waiting for the department supervisor's first approval through HR (routed_to = 'department').
 * HR answers each with a RequestDecided event. Same requests HR receives as *Requested events; this is the pull view.
 */
export async function hrPendingFirstApprovals(q) {
  const filter = oneOf(q.request_type, ["leave", "overtime", "attendance_correction", "leave_conversion"], "request_type");
  const parts = [];
  if (!filter || filter === "leave") parts.push(
    `SELECT 'leave' AS request_type, l.application_no AS request_no, e.hr_employee_id AS employee_id, e.employee_no, e.supervisor_hr_id AS supervisor_employee_id,
            CONCAT(t.name, ': ', DATE_FORMAT(l.start_date,'%Y-%m-%d'), ' to ', DATE_FORMAT(l.end_date,'%Y-%m-%d'), ' (', l.days, ' day/s)') AS summary, l.reason, l.submitted_at AS sort_at
       FROM leave_applications l JOIN employees e ON e.id = l.employee_id JOIN leave_types t ON t.id = l.leave_type_id
      WHERE l.status = 'pending' AND l.supervisor_status = 'pending' AND l.routed_to = 'department'`);
  if (!filter || filter === "overtime") parts.push(
    `SELECT 'overtime', o.request_no, e.hr_employee_id, e.employee_no, e.supervisor_hr_id,
            CONCAT(DATE_FORMAT(o.work_date,'%Y-%m-%d'), ' ', TIME_FORMAT(o.start_time,'%H:%i'), '-', TIME_FORMAT(o.end_time,'%H:%i'), ' (', o.hours, ' h, ', o.ot_type, ')'), o.reason, o.submitted_at
       FROM overtime_records o JOIN employees e ON e.id = o.employee_id
      WHERE o.status = 'pending' AND o.supervisor_status = 'pending' AND o.routed_to = 'department'`);
  if (!filter || filter === "attendance_correction") parts.push(
    `SELECT 'attendance_correction', c.request_no, e.hr_employee_id, e.employee_no, e.supervisor_hr_id,
            CONCAT(DATE_FORMAT(c.work_date,'%Y-%m-%d'), ': ', COALESCE(TIME_FORMAT(c.requested_time_in,'%H:%i'),'--'), '-', COALESCE(TIME_FORMAT(c.requested_time_out,'%H:%i'),'--'), ' ', COALESCE(c.requested_status,'')), c.reason, c.submitted_at
       FROM attendance_correction_requests c JOIN employees e ON e.id = c.employee_id
      WHERE c.status = 'pending' AND c.supervisor_status = 'pending' AND c.routed_to = 'department'`);
  if (!filter || filter === "leave_conversion") parts.push(
    `SELECT 'leave_conversion', v.conversion_no, e.hr_employee_id, e.employee_no, e.supervisor_hr_id,
            CONCAT('Convert ', v.days, ' leave day/s of ', v.year, ' to cash'), NULL, v.requested_at
       FROM leave_conversions v JOIN employees e ON e.id = v.employee_id
      WHERE v.status = 'pending' AND v.supervisor_status = 'pending' AND v.routed_to = 'department'`);
  const rows = await select(`SELECT * FROM (${parts.join(" UNION ALL ")}) x ORDER BY sort_at, request_no`);
  return {
    requests: rows.map(({ sort_at, ...r }) => ({ ...r, submitted_at: sort_at ? new Date(sort_at).toISOString() : null })),
    answer_with: "POST /api/v1/events with event_type RequestDecided",
  };
}

/** Payroll periods of a year (default: this year) with their run status. */
export async function hrPayrollPeriods(q) {
  const year = q.year ? parseInt(q.year, 10) : new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();
  if (!(year >= 2000 && year <= 2100)) throw badRequest("year must be a four-digit year.");
  const rows = await select(
    `SELECT p.id, p.code, p.label, p.pay_frequency, p.cutoff, d.code AS department_code, ${D("p.start_date")}, ${D("p.end_date")},
            ${D("p.pay_date")}, ${D("p.release_date")}, p.include_thirteenth, p.status AS period_status,
            b.batch_no, b.status AS payroll_status, b.employee_count
       FROM payroll_periods p
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN payroll_batches b ON b.id = (SELECT MAX(id) FROM payroll_batches WHERE period_id = p.id AND status <> 'voided')
      WHERE YEAR(p.end_date) = ? ORDER BY p.start_date, p.id`, [year]);
  return { year, periods: rows.map((r) => ({ ...r, include_thirteenth: !!r.include_thirteenth })) };
}

const PAID_STATES = ["approved", "finalized", "released"];

/** Totals of an approved payroll run, overall and per department. Amounts appear only once the run is approved. */
export async function hrPayrollPeriodSummary(periodId) {
  const p = await selectOne(`SELECT id, code, label, ${D("start_date")}, ${D("end_date")}, ${D("pay_date")}, ${D("release_date")}, status FROM payroll_periods WHERE id = ?`, [periodId]);
  if (!p) throw notFound("Payroll period not found.");
  const b = await selectOne("SELECT id, batch_no, status FROM payroll_batches WHERE period_id = ? AND status <> 'voided' ORDER BY id DESC LIMIT 1", [p.id]);
  if (!b || !PAID_STATES.includes(b.status)) return { period: p, payroll_status: b?.status || "not_started", summary: null, departments: [] };
  const sums = `COUNT(*) AS employees, SUM(gross_pay) AS gross_pay, SUM(statutory_employee) AS statutory_employee, SUM(withholding_tax) AS withholding_tax,
                SUM(total_deductions) AS total_deductions, SUM(net_pay) AS net_pay, SUM(employer_contributions) AS employer_contributions`;
  const [all, depts] = await Promise.all([
    selectOne(`SELECT ${sums} FROM payroll_records WHERE batch_id = ? AND status <> 'voided'`, [b.id]),
    select(`SELECT department_name, ${sums} FROM payroll_records WHERE batch_id = ? AND status <> 'voided' GROUP BY department_name ORDER BY department_name`, [b.id]),
  ]);
  const money = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "department_name" ? v : num(v)]));
  return { period: p, batch_no: b.batch_no, payroll_status: b.status, summary: money(all), departments: depts.map(money) };
}

/** Released payslips of one employee (summary figures; the PDF stays in JVzPay Self-Service). */
export async function hrEmployeePayslips(hrId, q) {
  const e = await employeeByHrId(hrId);
  const { limit, offset } = paging(q);
  const rows = await select(
    `SELECT s.payslip_no, p.code AS period_code, ${D("p.start_date", "period_start")}, ${D("p.end_date", "period_end")}, ${D("p.pay_date")},
            r.days_worked, r.days_absent, r.late_minutes, r.undertime_minutes, r.overbreak_minutes, r.overtime_hours,
            r.basic_pay, r.overtime_pay, r.holiday_pay, r.night_diff_pay, r.allowances, r.other_earnings, r.gross_pay,
            r.statutory_employee, r.withholding_tax, r.other_deductions, r.total_deductions, r.net_pay, ${DT("s.released_at")}
       FROM payslips s JOIN payroll_records r ON r.id = s.record_id JOIN payroll_periods p ON p.id = r.period_id
      WHERE s.employee_id = ? AND s.status = 'released' ORDER BY p.end_date DESC LIMIT ? OFFSET ?`, [e.id, limit, offset]);
  const textCols = new Set(["payslip_no", "period_code", "period_start", "period_end", "pay_date", "released_at"]);
  return {
    employee_id: e.hr_employee_id, employee_no: e.employee_no,
    payslips: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, textCols.has(k) ? v : num(v)]))),
    limit, offset,
  };
}

// ================================================= CRM ======================================================================

/** How JVzPay posted a sale the CRM sent (SaleCompleted), with its receivable if it was on account. */
export async function crmSale(transactionId) {
  const s = await selectOne(
    `SELECT s.transaction_id, s.order_id, s.customer_ref, ${D("s.transaction_date")}, s.payment_status, s.gross_amount, s.discount_amount, s.tax_amount,
            s.total_amount, s.refunded_amount, s.status, j.entry_no AS journal_entry_no, j.status AS journal_status,
            ar.receivable_no, ar.amount AS receivable_amount, ar.amount_collected, ar.status AS receivable_status, ${D("ar.due_date")}
       FROM sales_imports s LEFT JOIN journal_entries j ON j.id = s.journal_entry_id LEFT JOIN accounts_receivable ar ON ar.id = s.receivable_id
      WHERE s.transaction_id = ?`, [String(transactionId)]);
  if (!s) throw notFound("JVzPay has no sale with that transaction_id. Check the event's status with GET /api/v1/events/{event_id}.");
  return {
    transaction_id: s.transaction_id, order_id: s.order_id, customer_ref: s.customer_ref, transaction_date: s.transaction_date,
    payment_status: s.payment_status, gross_amount: num(s.gross_amount), discount_amount: num(s.discount_amount), tax_amount: num(s.tax_amount),
    total_amount: num(s.total_amount), refunded_amount: num(s.refunded_amount), status: s.status,
    journal_entry: s.journal_entry_no ? { entry_no: s.journal_entry_no, status: s.journal_status } : null,
    receivable: s.receivable_no ? { receivable_no: s.receivable_no, amount: num(s.receivable_amount), amount_collected: num(s.amount_collected), balance: num(s.receivable_amount) - num(s.amount_collected), status: s.receivable_status, due_date: s.due_date } : null,
  };
}

const AR_COLS = `ar.receivable_no, ar.crm_transaction_id AS transaction_id, ${D("ar.invoice_date")}, ${D("ar.due_date")}, ar.amount, ar.amount_collected,
  (ar.amount - ar.amount_collected) AS balance, ar.status, ar.description, c.crm_ref AS customer_ref, c.name AS customer_name`;
const arMoney = (r) => ({ ...r, amount: num(r.amount), amount_collected: num(r.amount_collected), balance: num(r.balance) });

/** Receivables (credit sales), filtered by customer and status. */
export async function crmReceivables(q) {
  const { limit, offset } = paging(q);
  const where = ["1=1"];
  const params = [];
  if (q.customer_ref) { where.push("c.crm_ref = ?"); params.push(String(q.customer_ref)); }
  const status = oneOf(q.status, ["unpaid", "partially_paid", "paid", "voided", "open"], "status");
  if (status === "open") where.push("ar.status IN ('unpaid','partially_paid')");
  else if (status) { where.push("ar.status = ?"); params.push(status); }
  const rows = await select(`SELECT ${AR_COLS} FROM accounts_receivable ar JOIN customers c ON c.id = ar.customer_id WHERE ${where.join(" AND ")} ORDER BY ar.invoice_date DESC, ar.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { receivables: rows.map(arMoney), limit, offset };
}

/** A CRM customer's outstanding balance with JVzPay (for credit-limit checks before selling on account). */
export async function crmCustomerBalance(customerRef) {
  const c = await selectOne("SELECT id, crm_ref, name, is_active FROM customers WHERE crm_ref = ?", [String(customerRef)]);
  if (!c) throw notFound("JVzPay has no customer with that customer_ref (a customer appears with its first on-account sale).");
  const open = await select(`SELECT ${AR_COLS} FROM accounts_receivable ar JOIN customers c ON c.id = ar.customer_id WHERE ar.customer_id = ? AND ar.status IN ('unpaid','partially_paid') ORDER BY ar.due_date`, [c.id]);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const items = open.map(arMoney);
  const sum = (xs) => Math.round(xs.reduce((s, r) => s + r.balance, 0) * 100) / 100;
  return {
    customer_ref: c.crm_ref, customer_name: c.name, is_active: !!c.is_active,
    outstanding_balance: sum(items), overdue_balance: sum(items.filter((r) => r.due_date && r.due_date < today)), open_receivables: items,
  };
}

// ================================================= Inventory ================================================================

const INV_COLS = `i.internal_no, i.invoice_no AS supplier_invoice_no, s.inventory_ref AS supplier_ref, s.name AS supplier_name, ${D("i.invoice_date")}, ${D("i.due_date")},
  i.amount, i.amount_paid, (i.amount - i.amount_paid) AS balance, i.purchase_order_ref AS purchase_order_id, i.goods_receipt_ref AS goods_receipt_id,
  i.match_status, i.match_note, i.status, i.decision_remarks`;
const invMoney = (r) => ({ ...r, amount: num(r.amount), amount_paid: num(r.amount_paid), balance: num(r.balance) });

/** A purchase order as JVzPay knows it: the PO, its goods receipts, supplier invoices (three-way match) and payments. */
export async function inventoryPurchaseOrder(poId) {
  const po = await selectOne(
    `SELECT po.purchase_order_id, s.inventory_ref AS supplier_ref, s.name AS supplier_name, ${D("po.order_date")}, po.total_amount
       FROM purchase_order_references po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.purchase_order_id = ?`, [String(poId)]);
  if (!po) throw notFound("JVzPay has no purchase order with that purchase_order_id. Send PurchaseOrderApproved first.");
  const [receipts, invoices] = await Promise.all([
    select(`SELECT goods_receipt_id, ${D("received_date")}, total_amount FROM goods_receipt_references WHERE purchase_order_id = ? ORDER BY received_date, id`, [po.purchase_order_id]),
    select(`SELECT i.id, ${INV_COLS} FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.purchase_order_ref = ? ORDER BY i.invoice_date, i.id`, [po.purchase_order_id]),
  ]);
  const payments = invoices.length
    ? await select(`SELECT supplier_invoice_id, payment_no, ${D("payment_date")}, amount, method, reference_no, status FROM supplier_payments WHERE supplier_invoice_id IN (?) ORDER BY payment_date, id`, [invoices.map((i) => i.id)])
    : [];
  return {
    ...po, total_amount: num(po.total_amount),
    goods_receipts: receipts.map((g) => ({ ...g, total_amount: num(g.total_amount) })),
    supplier_invoices: invoices.map(({ id, ...i }) => ({
      ...invMoney(i),
      payments: payments.filter((p) => p.supplier_invoice_id === id).map(({ supplier_invoice_id, ...p }) => ({ ...p, amount: num(p.amount) })),
    })),
  };
}

/** Supplier invoices (accounts payable), filtered by supplier and status. */
export async function inventorySupplierInvoices(q) {
  const { limit, offset } = paging(q);
  const where = ["1=1"];
  const params = [];
  if (q.supplier_ref) { where.push("s.inventory_ref = ?"); params.push(String(q.supplier_ref)); }
  const status = oneOf(q.status, ["pending_approval", "unpaid", "partially_paid", "paid", "rejected", "voided", "open"], "status");
  if (status === "open") where.push("i.status IN ('pending_approval','unpaid','partially_paid')");
  else if (status) { where.push("i.status = ?"); params.push(status); }
  const rows = await select(`SELECT ${INV_COLS} FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE ${where.join(" AND ")} ORDER BY i.invoice_date DESC, i.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { supplier_invoices: rows.map(invMoney), limit, offset };
}

/** What JVzPay still owes a supplier. */
export async function inventorySupplierBalance(supplierRef) {
  const s = await selectOne("SELECT id, inventory_ref, name, payment_terms_days, is_active FROM suppliers WHERE inventory_ref = ?", [String(supplierRef)]);
  if (!s) throw notFound("JVzPay has no supplier with that supplier_ref (a supplier appears with its first purchase order).");
  const open = await select(`SELECT ${INV_COLS} FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.supplier_id = ? AND i.status IN ('pending_approval','unpaid','partially_paid') ORDER BY i.due_date`, [s.id]);
  const items = open.map(invMoney);
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const sum = (xs) => Math.round(xs.reduce((t, r) => t + r.balance, 0) * 100) / 100;
  return {
    supplier_ref: s.inventory_ref, supplier_name: s.name, payment_terms_days: s.payment_terms_days, is_active: !!s.is_active,
    outstanding_balance: sum(items), overdue_balance: sum(items.filter((r) => r.due_date && r.due_date < today)), open_invoices: items,
  };
}
