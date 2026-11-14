// Payslips page (GET /payroll/payslips): all generated payslips (payslips.view_all).
import { wrap } from "../../lib/errors.js";
import { select, scalar } from "../../lib/db.js";
import { tableState, tableMeta, likeTerm } from "../../lib/paginate.js";

export const list = wrap(async (req, res) => {
  const t = tableState(req, { sortable: { period: "p.end_date", employee: "r.employee_name", net: "r.net_pay" }, defaultSort: "period", defaultDir: "desc", perPage: 25 });
  const period = /^\d+$/.test(req.query.period || "") ? Number(req.query.period) : null;
  const where = []; const params = [];
  if (period) { where.push("p.id = ?"); params.push(period); }
  if (t.q) { where.push("(r.employee_name LIKE ? OR r.employee_no LIKE ? OR s.payslip_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const from = "FROM payslips s JOIN payroll_records r ON r.id = s.record_id JOIN payroll_periods p ON p.id = r.period_id";
  const total = Number(await scalar(`SELECT COUNT(*) ${from} ${W}`, params));
  const rows = await select(
    `SELECT s.id, s.payslip_no, s.status, s.released_at, r.employee_name, r.employee_no, r.department_name, r.gross_pay, r.total_deductions, r.net_pay, r.status AS record_status, p.label AS period_label
       ${from} ${W} ORDER BY ${t.orderBy}, r.employee_name LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  const periods = await select("SELECT id, label FROM payroll_periods ORDER BY end_date DESC LIMIT 48");
  res.render("payslips", { title: "Payslips", rows, t, period, periods, meta: tableMeta(req, t, total, { period: period || undefined }) });
});
