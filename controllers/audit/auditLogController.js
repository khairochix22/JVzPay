/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Audit Logs page (GET /audit). audit.view = everything; audit.view_payroll = payroll-related modules only.
import { select, scalar } from "../../lib/db.js";
import { wrap } from "../../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../../lib/paginate.js";

const PAYROLL_MODULES = ["payroll", "attendance", "overtime", "leave", "bank", "payslips"];

export const auditLog = wrap(async (req, res) => {
  const full = req.user.can("audit.view");
  const t = tableState(req, { sortable: { time: "a.id", user: "a.user_name", action: "a.action", module: "a.module" }, defaultSort: "time", defaultDir: "desc", perPage: 25 });
  const modules = full
    ? (await select("SELECT DISTINCT module FROM audit_logs ORDER BY module")).map((m) => m.module)
    : PAYROLL_MODULES;
  const module = modules.includes(req.query.module) ? req.query.module : null;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : null;

  const where = [];
  const params = [];
  if (!full) { where.push(`a.module IN (${PAYROLL_MODULES.map(() => "?").join(",")})`); params.push(...PAYROLL_MODULES); }
  if (module) { where.push("a.module = ?"); params.push(module); }
  if (from) { where.push("a.created_at >= ?"); params.push(`${from} 00:00:00`); }
  if (to) { where.push("a.created_at <= ?"); params.push(`${to} 23:59:59`); }
  if (t.q) { where.push("(a.action LIKE ? OR a.user_name LIKE ? OR a.record_id = ? OR a.remarks LIKE ?)"); params.push(likeTerm(t.q), likeTerm(t.q), t.q, likeTerm(t.q)); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";

  const total = Number(await scalar(`SELECT COUNT(*) FROM audit_logs a ${W}`, params));
  const rows = await select(
    `SELECT a.* FROM audit_logs a ${W} ORDER BY ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  for (const row of rows) {
    row.prev = row.previous_value ? JSON.stringify(row.previous_value, null, 1) : null;
    row.next = row.new_value ? JSON.stringify(row.new_value, null, 1) : null;
  }
  res.render("audit", {
    title: "Audit Logs", rows, t, modules, module, from, to, full,
    meta: tableMeta(req, t, total, { module: module || undefined, from: from || undefined, to: to || undefined }),
  });
});
