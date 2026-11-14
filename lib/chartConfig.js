// Chart configs are serialised once on the server and read by public/js/charts.js from a data-* attribute.
// `slot` ties a series to a fixed colour (colour follows the entity, never its position).
export const lineChart = (title, labels, series, opts = {}) => JSON.stringify({ kind: "line", title, labels, xLabel: opts.xLabel || "Month", format: opts.format || "money", series });
export const barChart = (title, labels, series, opts = {}) => JSON.stringify({ kind: "bar", title, labels, xLabel: opts.xLabel || "Month", format: opts.format || "money", series, horizontal: !!opts.horizontal });
export const pieChart = (title, parts, opts = {}) => JSON.stringify({ ...JSON.parse(doughnutChart(title, parts, opts)), kind: "pie" });
export const doughnutChart = (title, parts, opts = {}) =>
  JSON.stringify({ kind: "doughnut", title, labels: parts.map((p) => p.name), xLabel: opts.xLabel || "Component", format: opts.format || "money", series: [{ name: opts.seriesName || "Amount", slot: 1, data: parts.map((p) => p.value) }], slots: parts.map((p, i) => p.slot || i + 1) });
export const segmentsChart = (title, parts) =>
  JSON.stringify({ kind: "segments", title, labels: [""], xLabel: "", format: "number", series: parts.map((p, i) => ({ name: p.name, slot: p.slot || i + 1, data: [p.value] })) });
export const payrollCostChart = (c) =>
  lineChart("Payroll cost per month", c.months, [{ name: "Payroll cost (earned pay + employer contributions)", slot: 1, data: c.cost }]);
