// Database integrity tests: prove the MySQL triggers / CHECK / UNIQUE rules enforce the business rules even if
// application code is bypassed. Every test runs inside a transaction that is ALWAYS rolled back (no data is left).
// Requires a migrated + seeded database (npm run migrate && npm run seed). Run: npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exec, selectOne, sequelize } from "../lib/db.js";
import { encrypt, decrypt, maskNumber } from "../lib/crypto.js";

const ROLLBACK = Symbol("rollback");
async function inRollback(fn) {
  try {
    await sequelize.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}
const msg = (e) => e?.original?.sqlMessage || e?.message || "";
async function rejects(promise, pattern) {
  try { await promise; } catch (e) { assert.match(msg(e), pattern); return; }
  assert.fail(`expected database to reject the statement (${pattern})`);
}

// minimal fixture chain: user, department, position, employee, period, batch, draft record
async function fixture(trx) {
  const role = await selectOne("SELECT id FROM roles WHERE code = 'payroll_staff'", [], trx);
  const u1 = (await exec("INSERT INTO users (role_id, email, full_name, password_hash) VALUES (?, 'it-staff@test.local', 'IT Staff', 'x')", [role.id], trx)).insertId;
  const u2 = (await exec("INSERT INTO users (role_id, email, full_name, password_hash) VALUES (?, 'it-sup@test.local', 'IT Sup', 'x')", [role.id], trx)).insertId;
  const dept = (await exec("INSERT INTO departments (code, name) VALUES ('ITEST','Integrity Test')", [], trx)).insertId;
  const pos = (await exec("INSERT INTO positions (department_id, title) VALUES (?, 'Tester')", [dept], trx)).insertId;
  const emp = (await exec(
    `INSERT INTO employees (employee_no, first_name, last_name, department_id, position_id, date_hired, basic_salary)
     VALUES ('IT-0001','Test','Employee',?,?,'2025-01-01',15000)`, [dept, pos], trx)).insertId;
  const period = (await exec(
    "INSERT INTO payroll_periods (code, label, pay_frequency, start_date, end_date) VALUES ('IT-P1','IT period','semi_monthly','2026-01-01','2026-01-15')", [], trx)).insertId;
  const batch = (await exec("INSERT INTO payroll_batches (batch_no, period_id, prepared_by) VALUES ('IT-B1', ?, ?)", [period, u1], trx)).insertId;
  const record = (await exec(
    `INSERT INTO payroll_records (batch_id, period_id, employee_id, employee_no, employee_name, rate_basis, rate_amount,
       basic_pay, gross_pay, statutory_employee, withholding_tax, other_deductions, total_deductions, net_pay)
     VALUES (?,?,?,'IT-0001','Test Employee','monthly',15000, 7500, 7500, 500, 0, 0, 500, 7000)`, [batch, period, emp], trx)).insertId;
  return { u1, u2, dept, pos, emp, period, batch, record };
}

test("payroll: one active record per employee per period", () =>
  inRollback(async (trx) => {
    const f = await fixture(trx);
    await rejects(
      exec(`INSERT INTO payroll_records (batch_id, period_id, employee_id, employee_no, employee_name, rate_basis, rate_amount)
            VALUES (?,?,?,'IT-0001','dup','monthly',1)`, [f.batch, f.period, f.emp], trx),
      /Duplicate entry/
    );
  }));

test("payroll: gross / deductions / net arithmetic is enforced by CHECK constraints", () =>
  inRollback(async (trx) => {
    const f = await fixture(trx);
    await rejects(exec("UPDATE payroll_records SET net_pay = 9999 WHERE id = ?", [f.record], trx), /chk_pr_net/);
    await rejects(exec("UPDATE payroll_records SET basic_pay = 1 WHERE id = ?", [f.record], trx), /chk_pr_gross/);
  }));

test("payroll: approved records are frozen; finalized can only move forward", () =>
  inRollback(async (trx) => {
    const f = await fixture(trx);
    await exec("UPDATE payroll_records SET status = 'approved' WHERE id = ?", [f.record], trx);
    await rejects(exec("UPDATE payroll_records SET basic_pay = 8000, gross_pay = 8000, net_pay = 7500 WHERE id = ?", [f.record], trx), /cannot be edited/);
    await rejects(exec("INSERT INTO payroll_earnings (record_id, component_id, description, amount) VALUES (?, 1, 'sneaky', 100)", [f.record], trx), /locked/);
    await rejects(exec("DELETE FROM payroll_records WHERE id = ?", [f.record], trx), /cannot be deleted/);
    await exec("UPDATE payroll_records SET status = 'finalized' WHERE id = ?", [f.record], trx);
    await rejects(exec("UPDATE payroll_records SET status = 'draft' WHERE id = ?", [f.record], trx), /Invalid payroll status transition/);
    await exec("UPDATE payroll_records SET status = 'voided', active_flag = NULL WHERE id = ?", [f.record], trx);
    // a voided record frees the slot so the period can be re-processed through the authorised correction path
    await exec(`INSERT INTO payroll_records (batch_id, period_id, employee_id, employee_no, employee_name, rate_basis, rate_amount)
                VALUES (?,?,?,'IT-0001','Test Employee','monthly',15000)`, [f.batch, f.period, f.emp], trx);
  }));

test("payroll: approver can never be the preparer (separation of duties)", () =>
  inRollback(async (trx) => {
    const f = await fixture(trx);
    await rejects(exec("UPDATE payroll_batches SET status = 'approved', approved_by = prepared_by WHERE id = ?", [f.batch], trx), /chk_pb_sod/);
    await exec("UPDATE payroll_batches SET status = 'approved', approved_by = ? WHERE id = ?", [f.u2, f.batch], trx);
    await rejects(exec("UPDATE payroll_batches SET total_net = 1 WHERE id = ?", [f.batch], trx), /cannot be modified/);
  }));

test("journal: unbalanced entries cannot be posted; posted entries are immutable", () =>
  inRollback(async (trx) => {
    const f = await fixture(trx);
    const cash = await selectOne("SELECT id FROM chart_of_accounts WHERE code = '1010'", [], trx);
    const sales = await selectOne("SELECT id FROM chart_of_accounts WHERE code = '4010'", [], trx);
    const je = (await exec("INSERT INTO journal_entries (entry_no, entry_date, description, source_type, source_id, created_by) VALUES ('IT-JE1','2026-01-10','test','manual',999001,?)", [f.u1], trx)).insertId;
    await exec("INSERT INTO journal_entry_lines (entry_id, line_no, account_id, debit) VALUES (?,1,?,100.00)", [je, cash.id], trx);
    await exec("INSERT INTO journal_entry_lines (entry_id, line_no, account_id, credit) VALUES (?,2,?,99.99)", [je, sales.id], trx);
    await rejects(exec("UPDATE journal_entries SET status = 'posted' WHERE id = ?", [je], trx), /debits must equal total credits/);
    await exec("UPDATE journal_entry_lines SET credit = 100.00 WHERE entry_id = ? AND line_no = 2", [je], trx);
    await exec("UPDATE journal_entries SET status = 'posted', posted_by = ? WHERE id = ?", [f.u1, je], trx);
    const row = await selectOne("SELECT total_debit, total_credit FROM journal_entries WHERE id = ?", [je], trx);
    assert.equal(row.total_debit, "100.00"); // totals derived from lines by the trigger
    await rejects(exec("UPDATE journal_entry_lines SET debit = 5 WHERE entry_id = ?", [je], trx), /immutable/);
    await rejects(exec("UPDATE journal_entries SET description = 'edited' WHERE id = ?", [je], trx), /immutable/);
    await rejects(exec("DELETE FROM journal_entries WHERE id = ?", [je], trx), /cannot be deleted/);
    await rejects(exec("INSERT INTO journal_entry_lines (entry_id, line_no, account_id, debit, credit) VALUES (?,3,?,5,5)", [je, cash.id], trx), /immutable|chk_jel_amt/);
  }));

test("journal: the same payroll batch cannot be booked twice", () =>
  inRollback(async (trx) => {
    const f = await fixture(trx);
    await exec("INSERT INTO journal_entries (entry_no, entry_date, description, source_type, source_id, source_event, created_by) VALUES ('IT-JA','2026-01-15','accrual','payroll_batch',?, 'accrual', ?)", [f.batch, f.u1], trx);
    await rejects(
      exec("INSERT INTO journal_entries (entry_no, entry_date, description, source_type, source_id, source_event, created_by) VALUES ('IT-JB','2026-01-15','again','payroll_batch',?, 'accrual', ?)", [f.batch, f.u1], trx),
      /Duplicate entry/
    );
  }));

test("audit log and approval history are append-only", () =>
  inRollback(async (trx) => {
    const f = await fixture(trx);
    const a = (await exec("INSERT INTO audit_logs (action, module) VALUES ('it_test','tests')", [], trx)).insertId;
    await rejects(exec("UPDATE audit_logs SET action = 'tampered' WHERE id = ?", [a], trx), /append-only/);
    await rejects(exec("DELETE FROM audit_logs WHERE id = ?", [a], trx), /append-only/);
    // sealing is the one update allowed, and only once
    await exec("UPDATE audit_logs SET seal_seq = 4000000000, seal_hash = REPEAT('a', 64) WHERE id = ?", [a], trx);
    await rejects(exec("UPDATE audit_logs SET seal_hash = REPEAT('b', 64) WHERE id = ?", [a], trx), /append-only/);
    const pa = (await exec("INSERT INTO payroll_approvals (batch_id, action, actor_id, actor_role) VALUES (?, 'submitted', ?, 'payroll_staff')", [f.batch, f.u1], trx)).insertId;
    await rejects(exec("UPDATE payroll_approvals SET action = 'approved' WHERE id = ?", [pa], trx), /append-only/);
  }));

test("bank: only one active payroll account per employee", () =>
  inRollback(async (trx) => {
    const f = await fixture(trx);
    const ins = () => exec(
      `INSERT INTO bank_accounts (employee_id, bank_name, account_holder_name, account_number_enc, account_last4, account_type, active_flag, approved_by, approved_at)
       VALUES (?, 'LANDBANK', 'Test Employee', ?, '7890', 'savings', 1, ?, NOW())`, [f.emp, encrypt("1234567890"), f.u2], trx);
    await ins();
    await rejects(ins(), /Duplicate entry/);
  }));

test("seeded leave policy: sick leave needs a document beyond 2 days; LWOP is unpaid and uncapped", async () => {
  const sl = await selectOne("SELECT requires_attachment, attachment_after_days FROM leave_types WHERE code = 'SL'");
  assert.equal(sl.requires_attachment, 1);
  assert.equal(sl.attachment_after_days, "2.0");
  const lwop = await selectOne("SELECT is_paid, allow_negative_balance FROM leave_types WHERE code = 'LWOP'");
  assert.deepEqual([lwop.is_paid, lwop.allow_negative_balance], [0, 1]);
});

test("statutory reference defaults are seeded UNVERIFIED", () => {
  // Checked against the seed itself, because an administrator verifying a rate later is correct and must not fail this test.
  const seed = readFileSync(new URL("../database/seeds/run.js", import.meta.url), "utf8");
  const inserts = seed.match(/INSERT INTO (statutory_contribution_rules|withholding_tax_brackets)[\s\S]*?\)`/g);
  assert.equal(inserts.length, 2, "one insert for rules, one for tax brackets");
  for (const sql of inserts) assert.match(sql, /is_verified\)[\s\S]*,0\)`$/, "nothing may be marked verified by the seed");
});

test("crypto: AES-256-GCM round trip, tamper detection, masking", () => {
  const blob = encrypt("001234567890");
  assert.notEqual(blob, encrypt("001234567890"), "random IV per encryption");
  assert.equal(decrypt(blob), "001234567890");
  const parts = blob.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decrypt(parts.join(":")));
  assert.equal(maskNumber("001234567890"), "••••••••7890");
});

after(() => sequelize.close());
