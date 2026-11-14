// Builds the page + export handlers for one report definition; each report's controller file is a one-liner over this.
import { wrap, badRequest } from "./errors.js";
import { select, selectOne } from "./db.js";
import { audit } from "./audit.js";
import { env } from "../config/env.js";
import { formatPHP } from "./money.js";
import { toXlsx, toPdf } from "./reportExport.js";
import { fullName } from "../services/employeeService.js";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isId = (s) => /^\d+$/.test(s || "");
const STATUSES = ["active", "on_leave", "suspended", "resigned", "terminated"];

async function readFilters(def, q) {
  const now = new Date();
  const f = {};
  const has = (k) => def.filters.includes(k);
  if (has("from")) f.from = isDate(q.from) ? q.from : iso(new Date(now.getFullYear(), now.getMonth(), 1));
  if (has("to")) f.to = isDate(q.to) ? q.to : iso(now);
  if (has("from") && has("to") && f.from > f.to) [f.from, f.to] = [f.to, f.from];
  if (has("asOf")) f.asOf = isDate(q.asOf) ? q.asOf : iso(now);
  if (has("year")) f.year = /^\d{4}$/.test(q.year || "") ? Number(q.year) : now.getFullYear();
  if (has("department")) f.department = isId(q.department) ? Number(q.department) : null;
  if (has("employee")) f.employee = isId(q.employee) ? Number(q.employee) : null;
  if (has("account")) f.account = isId(q.account) ? Number(q.account) : null;
  if (has("category")) f.category = isId(q.category) ? Number(q.category) : null;
  if (has("status")) f.status = STATUSES.includes(q.status) ? q.status : null;
  if (has("period")) {
    f.period = isId(q.period) ? Number(q.period) : null;
    if (!f.period) f.period = (await selectOne("SELECT p.id FROM payroll_periods p JOIN payroll_records r ON r.period_id = p.id AND r.active_flag = 1 ORDER BY p.end_date DESC LIMIT 1"))?.id ?? null;
  }
  return f;
}

async function filterOptions(def) {
  const has = (k) => def.filters.includes(k);
  const o = {};
  if (has("department")) o.departments = await select("SELECT id, name FROM departments WHERE deleted_at IS NULL ORDER BY name");
  if (has("employee")) o.employees = (await select("SELECT id, employee_no, first_name, middle_name, last_name, suffix FROM employees WHERE deleted_at IS NULL ORDER BY last_name, first_name")).map((e) => ({ id: e.id, label: `${fullName(e)} (${e.employee_no})` }));
  if (has("period")) o.periods = await select("SELECT id, label FROM payroll_periods ORDER BY end_date DESC LIMIT 60");
  if (has("account")) o.accounts = await select("SELECT id, code, name FROM chart_of_accounts ORDER BY code");
  if (has("category")) o.categories = await select("SELECT id, category_type, name FROM transaction_categories ORDER BY category_type, name");
  if (has("status")) o.statuses = STATUSES;
  return o;
}

const display = (col, v) => {
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "money") return formatPHP(v);
  if (col.type === "date") return String(v).slice(0, 10);
  return String(v);
};

export function reportPages(def) {
  const page = wrap(async (req, res) => {
    const filters = await readFilters(def, req.query);
    const data = await def.run(filters, req);
    const has = Object.fromEntries(def.filters.map((k) => [k, true]));
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== null && v !== undefined && v !== "")).toString();
    res.render("report", {
      title: def.title, def, f: filters, has, ...(await filterOptions(def)), data, qs,
      columns: data.columns.map((c) => ({ ...c, right: c.type === "money" || c.type === "num" })),
      rows: data.rows.map((r) => ({ kind: r._kind || "", heading: r._kind === "heading" ? r[data.columns[0].key] : null, cells: data.columns.map((c) => ({ v: display(c, r[c.key]), right: c.type === "money" || c.type === "num", label: c.label })) })),
      colspan: data.columns.length,
    });
  });
  const exportFile = wrap(async (req, res) => {
    const format = req.query.format;
    if (!["pdf", "xlsx"].includes(format)) throw badRequest("Unknown export format.");
    const filters = await readFilters(def, req.query);
    const data = await def.run(filters, req);
    await audit(req, { action: "report_exported", module: "reports", recordType: "report", recordId: def.key, remarks: `${format.toUpperCase()} ${JSON.stringify(filters)}`.slice(0, 500) });
    if (format === "xlsx") return toXlsx(def, data, env.company.name, res);
    toPdf(def, data, env.company.name, env.company.address, res);
  });
  return { page, exportFile };
}
