// Checks the payroll engine against the published schedules, using the values the seed loads.
// Sources: SSS Circular 2024-006; PhilHealth Advisory 2025-0002 and RA 11223 Sec. 10; Pag-IBIG Circular 460; RA 10963 Sec. 5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contribution, annualTax } from "../services/payrollEngine.js";

const SSS = { rounding_step: "500.00", salary_floor: "5000.00", salary_ceiling: "35000.00", employee_rate: "0.05", employer_rate: "0.10", ec_threshold: "15000.00", ec_amount_low: "10.00", ec_amount_high: "30.00" };
const PHILHEALTH = { rounding_step: "0.00", salary_floor: "10000.00", salary_ceiling: "100000.00", employee_rate: "0.025", employer_rate: "0.025", ec_threshold: "0.00", ec_amount_low: "0.00", ec_amount_high: "0.00" };
const PAGIBIG = { rounding_step: "0.00", salary_floor: "0.00", salary_ceiling: "10000.00", employee_rate: "0.02", employer_rate: "0.02", low_income_ceiling: "1500.00", low_income_employee_rate: "0.01", ec_threshold: "0.00", ec_amount_low: "0.00", ec_amount_high: "0.00" };
const c = (pesos) => Math.round(pesos * 100);

test("SSS: all 61 rows of the January 2025 schedule, at both ends of each compensation range", () => {
  let rows = 0;
  for (let msc = 5000; msc <= 35000; msc += 500, rows++) {
    const low = msc === 5000 ? 100 : msc - 250;
    const high = msc === 35000 ? 500000 : msc + 249.99;
    for (const pay of [low, high]) {
      const got = contribution(SSS, c(pay));
      assert.equal(got.base, c(msc), `MSC for compensation ${pay}`);
      assert.equal(got.ee, c(msc * 0.05), `employee share at MSC ${msc}`);
      assert.equal(got.er, c(msc * 0.1), `employer share at MSC ${msc}`);
      assert.equal(got.ec, c(msc < 15000 ? 10 : 30), `EC at MSC ${msc}`);
    }
  }
  assert.equal(rows, 61);
});

test("SSS: totals printed in the circular", () => {
  const total = (pay) => { const x = contribution(SSS, c(pay)); return x.ee + x.er + x.ec; };
  assert.equal(total(5000), c(760));
  assert.equal(total(14500), c(2185));
  assert.equal(total(15000), c(2280));
  assert.equal(total(20000), c(3030));
  assert.equal(total(35000), c(5280));
});

test("PhilHealth: 5% shared equally between the ₱10,000 floor and ₱100,000 ceiling", () => {
  assert.deepEqual([contribution(PHILHEALTH, c(8000)).ee, contribution(PHILHEALTH, c(8000)).er], [c(250), c(250)]);
  assert.deepEqual([contribution(PHILHEALTH, c(40000)).ee, contribution(PHILHEALTH, c(40000)).er], [c(1000), c(1000)]);
  assert.deepEqual([contribution(PHILHEALTH, c(250000)).ee, contribution(PHILHEALTH, c(250000)).er], [c(2500), c(2500)]);
});

test("Pag-IBIG: the employee share is 1% at ₱1,500 or below; the employer share stays 2%", () => {
  assert.deepEqual([contribution(PAGIBIG, c(1500)).ee, contribution(PAGIBIG, c(1500)).er], [c(15), c(30)]);
  assert.deepEqual([contribution(PAGIBIG, c(1000)).ee, contribution(PAGIBIG, c(1000)).er], [c(10), c(20)]);
  assert.deepEqual([contribution(PAGIBIG, c(1500.01)).ee, contribution(PAGIBIG, c(1500.01)).er], [c(30), c(30)]);
});

test("Pag-IBIG: 2% each on a fund salary capped at ₱10,000", () => {
  assert.deepEqual([contribution(PAGIBIG, c(30000)).ee, contribution(PAGIBIG, c(30000)).er], [c(200), c(200)]);
  assert.deepEqual([contribution(PAGIBIG, c(6000)).ee, contribution(PAGIBIG, c(6000)).er], [c(120), c(120)]);
});

test("income tax: the graduated table in force from January 1, 2023", () => {
  const brackets = [[0, 250000, 0, 0], [250000, 400000, 0, 0.15], [400000, 800000, 22500, 0.2], [800000, 2000000, 102500, 0.25], [2000000, 8000000, 402500, 0.3], [8000000, null, 2202500, 0.35]]
    .map(([annual_from, annual_to, base_tax, rate]) => ({ annual_from: String(annual_from), annual_to: annual_to === null ? null : String(annual_to), base_tax: String(base_tax), rate: String(rate) }));
  assert.equal(annualTax(brackets, c(250000)), 0);
  assert.equal(annualTax(brackets, c(300000)), c(7500));
  assert.equal(annualTax(brackets, c(400000)), c(22500));
  assert.equal(annualTax(brackets, c(1000000)), c(152500));
  assert.equal(annualTax(brackets, c(9000000)), c(2552500));
});
