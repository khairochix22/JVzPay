// Pure unit tests (no database). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCents, fromCents, formatPHP, isMoney } from "../lib/money.js";
import { validate, checkPassword } from "../lib/validate.js";
import { splitSql } from "../database/sqlSplit.js";
import { redact } from "../lib/audit.js";
import { readFileSync, readdirSync } from "node:fs";

test("money: exact centavo arithmetic, no float drift", () => {
  assert.equal(toCents("0.1") + toCents("0.2"), 30);
  assert.equal(fromCents(toCents("0.1") + toCents("0.2")), "0.30");
  assert.equal(toCents("1,234.56"), 123456);
  assert.equal(toCents("520"), 52000);
  assert.equal(toCents("1.005"), 101); // half-up on the 3rd decimal
  assert.equal(toCents("-15.5"), -1550);
  assert.equal(fromCents(-1550), "-15.50");
  assert.throws(() => toCents("12abc"));
});

test("money: PHP formatting", () => {
  assert.equal(formatPHP("1234567.5"), "₱1,234,567.50");
  assert.equal(formatPHP(null), "₱0.00");
  assert.equal(formatPHP("-20"), "-₱20.00");
  assert.ok(isMoney("18,000.00") && isMoney("0.5") && !isMoney("1.234") && !isMoney("-1"));
});

test("validate: required, types, enums, normalisation", () => {
  const { values, errors, ok } = validate(
    { name: "  Ana ", email: "ANA@Example.COM", amount: "1,500.50", kind: "x", n: "7", flag: "on" },
    {
      name: { required: true, max: 10 }, email: { type: "email" }, amount: { type: "money", min: 0 },
      kind: { type: "enum", values: ["a", "b"] }, n: { type: "int", max: 5 }, flag: { type: "bool" }, missing: { required: true },
    }
  );
  assert.equal(ok, false);
  assert.equal(values.name, "Ana");
  assert.equal(values.email, "ana@example.com");
  assert.equal(values.amount, "1500.50");
  assert.equal(values.flag, 1);
  assert.ok(errors.kind && errors.n && errors.missing);
  assert.ok(!errors.name && !errors.email && !errors.amount);
});

test("password policy", () => {
  assert.ok(checkPassword("short1"));
  assert.ok(checkPassword("onlyletterslong"));
  assert.ok(checkPassword("maria2026secure", "maria@johnvivz.local"), "must not contain the email name");
  assert.equal(checkPassword("Ledger2026xyz", "maria@johnvivz.local"), null);
});

test("sql splitter honours DELIMITER blocks (triggers)", () => {
  const sql = `-- c\nCREATE TABLE a (id INT);\nDELIMITER $$\nCREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW\nBEGIN\n  SET @x = 1;\n  SET @y = 2;\nEND$$\nDELIMITER ;\nINSERT INTO a VALUES (1);`;
  const s = splitSql(sql);
  assert.equal(s.length, 3);
  assert.match(s[1], /^CREATE TRIGGER[\s\S]*SET @y = 2;\nEND$/);
});

test("payslip PDF text: peso sign spelled out, unsupported glyphs replaced, plain 's' untouched", async () => {
  const { pdfText } = await import("../services/payslipService.js");
  assert.equal(pdfText("Basic pay (13 days × ₱560.00)"), "Basic pay (13 days × PHP 560.00)");
  assert.equal(pdfText("₱ 5 sss — Ñiño"), "PHP 5 sss — Ñiño");
  assert.equal(pdfText("✓ 日本"), "? ??");
});

test("attendance: lateness, grace period, undertime, break and the 8-hour cap", async () => {
  const { computeDay } = await import("../services/attendanceService.js");
  const cfg = { start: 480, end: 1020, breakMin: 60, grace: 10, hoursPerDay: 8 }; // 08:00–17:00
  const day = (status, time_in, time_out) => computeDay({ status, time_in, time_out }, cfg);
  assert.deepEqual(day("present", "08:00", "17:00"), { status: "present", time_in: "08:00", time_out: "17:00", late_minutes: 0, undertime_minutes: 0, hours_worked: 8 });
  assert.equal(day("present", "08:10", "17:00").late_minutes, 0, "inside the grace period");
  assert.deepEqual([day("present", "08:25", "17:00").status, day("present", "08:25", "17:00").late_minutes], ["late", 25], "beyond grace counts in full");
  assert.equal(day("present", "08:25", "17:00").hours_worked, 7.58);
  assert.deepEqual([day("present", "08:00", "16:30").undertime_minutes, day("present", "08:00", "16:30").hours_worked], [30, 7.5]);
  assert.deepEqual([day("half_day", "08:00", "12:00").status, day("half_day", "08:00", "12:00").hours_worked, day("half_day", "08:00", "12:00").undertime_minutes], ["half_day", 4, 0], "no break under 5 h; half day has no undertime");
  assert.equal(day("present", "07:00", "19:00").hours_worked, 8, "regular hours capped; extra time is overtime only if approved");
  assert.equal(day("late", "08:00", "17:00").status, "present", "status is recomputed from the times");
  assert.deepEqual(day("absent", "08:00", "17:00"), { status: "absent", time_in: null, time_out: null, late_minutes: 0, undertime_minutes: 0, hours_worked: 0 });
  assert.equal(day("holiday", null, null).hours_worked, 0);
  assert.equal(day("holiday", "08:00", "17:00").hours_worked, 8, "worked holiday keeps its status");
  assert.throws(() => day("present", "17:00", "08:00"), /later than time in/);
  assert.throws(() => day("present", null, "17:00"), /required/);
});

test("audit redaction never leaks sensitive keys", () => {
  const out = redact({ name: "A", password: "x", tin: "123", sss_no: "34", account_number_enc: "v1:..", nested: { new_password: "y" } });
  assert.deepEqual(out, { name: "A", password: "[REDACTED]", tin: "[REDACTED]", sss_no: "[REDACTED]", account_number_enc: "[REDACTED]", nested: { new_password: "[REDACTED]" } });
});

test("views never print a field whose name is also a helper (the helper would run instead)", () => {
  const helpers = [...readFileSync(new URL("../lib/hbsHelpers.js", import.meta.url), "utf8").matchAll(/\bh\("(\w+)"/g)].map((m) => m[1]);
  assert.ok(helpers.includes("date") && helpers.includes("pct"), "helper names were found");
  const bare = new RegExp(`\\{\\{\\s*(${helpers.join("|")})\\s*\\}\\}`);
  const dir = new URL("../views/", import.meta.url);
  const offenders = readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith(".xian"))
    .filter((f) => bare.test(readFileSync(new URL(String(f).replace(/\\/g, "/"), dir), "utf8")));
  assert.deepEqual(offenders, [], "use {{this.name}} for these fields");
});
