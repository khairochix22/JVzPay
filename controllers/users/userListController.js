/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// User Accounts list page (GET /users).
import { select, scalar } from "../../lib/db.js";
import { wrap } from "../../lib/errors.js";
import { tableState, tableMeta, likeTerm } from "../../lib/paginate.js";

const roles = () => select("SELECT id, code, name FROM roles ORDER BY FIELD(code,'accounting_supervisor','accounting_staff','payroll_staff','employee')");

export const list = wrap(async (req, res) => {
  const t = tableState(req, { sortable: { name: "u.full_name", email: "u.email", role: "r.name", status: "u.status", login: "u.last_login_at" }, defaultSort: "name" });
  const role = /^[a-z_]+$/.test(req.query.role || "") ? req.query.role : null;
  const where = ["u.deleted_at IS NULL"];
  const params = [];
  if (t.q) { where.push("(u.full_name LIKE ? OR u.email LIKE ?)"); params.push(likeTerm(t.q), likeTerm(t.q)); }
  if (role) { where.push("r.code = ?"); params.push(role); }
  const W = where.join(" AND ");
  const total = Number(await scalar(`SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE ${W}`, params));
  const rows = await select(
    `SELECT u.id, u.full_name, u.email, u.status, u.last_login_at, u.locked_until, u.must_change_password, r.name AS role_name, r.code AS role_code,
            e.employee_no, e.id AS employee_id, (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN employees e ON e.id = u.employee_id
      WHERE ${W} ORDER BY ${t.orderBy}, u.id LIMIT ${t.limit} OFFSET ${t.offset}`,
    params
  );
  res.render("users", { title: "User Accounts", rows, t, meta: tableMeta(req, t, total, { role: role || undefined }), roles: await roles(), role });
});
