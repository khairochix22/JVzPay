// Forecasting maths used by the Analytics page. Pure calculation; no rows are read or written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { linearForecast } from "../services/analyticsService.js";
import { sequelize } from "../lib/db.js";

after(() => sequelize.close());

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

test("forecast: needs at least three complete months", () => {
  assert.equal(linearForecast([], 3), null);
  assert.equal(linearForecast([100, 200], 3), null);
  assert.ok(linearForecast([100, 200, 300], 3));
});

test("forecast: a perfect trend is extended exactly, with no uncertainty", () => {
  const f = linearForecast([100, 200, 300, 400], 3);
  near(f.slope, 100);
  assert.deepEqual(f.points.map((p) => Math.round(p.value)), [500, 600, 700]);
  for (const p of f.points) { near(p.lower, p.value); near(p.upper, p.value); }
});

test("forecast: known least-squares result", () => {
  const f = linearForecast([2, 4, 5, 4, 5], 1);
  near(f.slope, 0.6);
  near(f.intercept, 2.8);
  near(f.points[0].value, 5.8);
});

test("forecast: the interval brackets the estimate and widens further out", () => {
  const f = linearForecast([120, 95, 140, 110, 150, 125], 3);
  for (const p of f.points) assert.ok(p.lower <= p.value && p.value <= p.upper);
  const width = (p) => p.upper - p.lower;
  assert.ok(width(f.points[1]) > width(f.points[0]));
  assert.ok(width(f.points[2]) > width(f.points[1]));
});

test("forecast: money is never projected below zero", () => {
  const f = linearForecast([300, 200, 100, 10], 6);
  for (const p of f.points) { assert.ok(p.value >= 0); assert.ok(p.lower >= 0); assert.ok(p.upper >= 0); }
});
