// Every database table has exactly one model file, and every model matches its live table column-for-column.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { select } from "../lib/db.js";
import { env } from "../config/env.js";
import { models, sequelize, Role, Employee, Department, Position } from "../models/index.js";

test("every table has a model, and every model has a table", async () => {
  const tables = (await select("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [env.db.name])).map((t) => t.TABLE_NAME).sort();
  const modelTables = Object.values(models).map((m) => m.getTableName()).sort();
  assert.deepEqual(modelTables, tables);
});

test("model attributes match table columns exactly (run `npm run models:generate` after a migration)", async () => {
  const cols = await select("SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?", [env.db.name]);
  for (const m of Object.values(models)) {
    const table = m.getTableName();
    const live = cols.filter((c) => c.TABLE_NAME === table);
    assert.deepEqual(Object.keys(m.getAttributes()).sort(), live.map((c) => c.COLUMN_NAME).sort(), `columns differ for ${table}`);
    for (const c of live) assert.equal(m.getAttributes()[c.COLUMN_NAME].allowNull, c.IS_NULLABLE === "YES", `nullability differs for ${table}.${c.COLUMN_NAME}`);
  }
});

test("models query the database and associations resolve", async () => {
  const roles = await Role.findAll({ order: [["code", "ASC"]] });
  assert.deepEqual(roles.map((r) => r.code), ["accounting_staff", "accounting_supervisor", "employee", "payroll_staff"]);
  const dept = await Department.findOne({ where: { code: "PAYROLL_ACCOUNTING" }, include: [{ model: Position, as: "positions" }] });
  assert.ok(dept && dept.positions.length >= 3, "Department hasMany Position");
  assert.ok(Employee.associations.department && Employee.associations.position, "Employee belongsTo Department/Position");
});

after(() => sequelize.close());
