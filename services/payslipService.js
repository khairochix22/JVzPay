// Payslips (Module 7): read model + PDF rendering. Only RELEASED payslips are official and visible to employees.
// The payroll engine that creates them (finalize → generate → release) is delivered in Phase 6.
import PDFDocument from "pdfkit";
import { select, selectOne } from "../lib/db.js";
import { getSetting } from "../lib/settings.js";
import { toCents, fromCents } from "../lib/money.js";
import { brandImage } from "../lib/brand.js";

export async function myPayslips(employeeId) {
  return select(
    `SELECT s.id, s.payslip_no, s.released_at, r.gross_pay, r.total_deductions, r.net_pay,
            p.label AS period_label, p.start_date, p.end_date, p.pay_date
       FROM payslips s JOIN payroll_records r ON r.id = s.record_id JOIN payroll_periods p ON p.id = r.period_id
      WHERE s.employee_id = ? AND s.status = 'released' AND r.status IN ('released')
      ORDER BY p.end_date DESC, s.id DESC`, [employeeId]);
}

/** Full payslip. `employeeId` restricts to that employee's RELEASED payslips (self-service); omit only for payslips.view_all. */
export async function getPayslip(id, { employeeId = null } = {}) {
  const s = await selectOne(
    `SELECT s.*, r.*, s.id AS payslip_id, s.status AS payslip_status, r.status AS record_status,
            p.label AS period_label, p.start_date, p.end_date, p.pay_date, p.pay_frequency
       FROM payslips s JOIN payroll_records r ON r.id = s.record_id JOIN payroll_periods p ON p.id = r.period_id
      WHERE s.id = ? ${employeeId ? "AND s.employee_id = ? AND s.status = 'released' AND r.status = 'released'" : ""}`,
    employeeId ? [id, employeeId] : [id]);
  if (!s) return null;
  const [earnings, deductions, contributions] = await Promise.all([
    select("SELECT e.description, e.quantity, e.rate, e.amount, c.category FROM payroll_earnings e JOIN salary_components c ON c.id = e.component_id WHERE e.record_id = ? ORDER BY e.id", [s.record_id]),
    select("SELECT d.description, d.amount, c.category FROM payroll_deductions d JOIN salary_components c ON c.id = d.component_id WHERE d.record_id = ? ORDER BY d.id", [s.record_id]),
    select("SELECT agency, base_amount, employee_share, employer_share, ec_share FROM payroll_contributions WHERE record_id = ? ORDER BY FIELD(agency,'SSS','PHILHEALTH','PAGIBIG')", [s.record_id]),
  ]);
  return { ...s, id: s.payslip_id, earnings, deductions, contributions };
}

// ---- PDF -----------------------------------------------------------------------------------------------------------------
// The standard PDF fonts have no peso glyph, so amounts print as "PHP 1,234.56" (common on Philippine payslips).
const php = (v) => {
  const c = toCents(v ?? 0);
  const [w, f] = fromCents(Math.abs(c)).split(".");
  return `${c < 0 ? "-" : ""}PHP ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
};
const d = (v) => {
  if (!v) return "-";
  const date = v instanceof Date ? v : new Date(String(v).length === 10 ? `${v}T00:00:00` : v);
  return date.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
};
const AGENCY = { SSS: "SSS", PHILHEALTH: "PhilHealth", PAGIBIG: "Pag-IBIG" };
// Standard PDF fonts only cover WinAnsi: spell out the peso sign and drop anything else they cannot draw.
const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export const pdfText = (v) =>
  String(v ?? "").replace(/\u20B1\s?/g, "PHP ").replace(/[^\x20-\x7E\xA0-\xFF]/g, (c) => (WINANSI_EXTRA.has(c) ? c : "?"));

export async function renderPayslipPdf(p, stream) {
  const company = await getSetting("company.name", "JohnVivz Grocery Store");
  const address = await getSetting("company.address", "Bongabong, Oriental Mindoro");
  const NAVY = "#142B4A", MUTED = "#64748B", INK = "#1E293B", LINE = "#E2E8F0";
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Payslip ${p.payslip_no}`, Author: company, Subject: p.period_label } });
  doc.pipe(stream);
  const W = doc.page.width - 80;
  const x0 = 40;

  // header: the full-colour JohnVivz logo straight on the page (no plate behind it), then a navy rule
  const logo = brandImage("full");
  const logoW = logo ? 96 : 0;
  if (logo) doc.image(logo, x0, 20, { width: logoW });
  const tx = logo ? x0 + logoW + 14 : x0;
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(18).text(pdfText(company), tx, 30, { width: W * 0.62 - (tx - x0) });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(pdfText(address), tx, 54, { width: W * 0.62 - (tx - x0) });
  doc.font("Helvetica-Bold").fontSize(16).fillColor(NAVY).text("PAYSLIP", x0, 30, { width: W, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`No. ${p.payslip_no}`, x0, 52, { width: W, align: "right" });
  doc.rect(0, 94, doc.page.width, 3).fill(NAVY);

  // employee + period block
  let y = 116;
  const kv = (label, value, x, yy, w) => {
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, yy, { width: w });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(pdfText(value) || "-", x, yy + 11, { width: w });
  };
  const col = W / 3;
  kv("Employee", p.employee_name, x0, y, col - 10);
  kv("Employee ID", p.employee_no, x0 + col, y, col - 10);
  kv("Payroll period", `${p.period_label}`, x0 + col * 2, y, col);
  y += 34;
  kv("Department", p.department_name, x0, y, col - 10);
  kv("Position", p.position_title, x0 + col, y, col - 10);
  kv("Period covered", `${d(p.start_date)} - ${d(p.end_date)}`, x0 + col * 2, y, col);
  y += 34;
  kv("Basic rate", `${php(p.rate_amount)} (${p.rate_basis})`, x0, y, col - 10);
  kv("Pay date", d(p.pay_date), x0 + col, y, col - 10);
  kv("Payment status", p.payslip_status === "released" ? "Released" : "Not yet released", x0 + col * 2, y, col);
  y += 44;

  // earnings | deductions tables
  const half = (W - 20) / 2;
  const table = (title, rows, x, top) => {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY).text(title, x, top);
    let yy = top + 16;
    doc.moveTo(x, yy).lineTo(x + half, yy).lineWidth(1).strokeColor(LINE).stroke();
    yy += 6;
    if (!rows.length) { doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("None", x, yy); yy += 16; }
    for (const [label, amount] of rows) {
      const text = pdfText(label);
      doc.font("Helvetica").fontSize(9).fillColor(INK).text(text, x, yy, { width: half - 100 });
      doc.text(php(amount), x + half - 100, yy, { width: 100, align: "right" });
      yy += Math.max(14, doc.heightOfString(text, { width: half - 100 }) + 3);
    }
    return yy;
  };
  const earningRows = p.earnings.length
    ? p.earnings.map((e) => [e.description, e.amount])
    : [["Basic pay", p.basic_pay], ["Overtime pay", p.overtime_pay], ["Holiday pay", p.holiday_pay], ["Night differential", p.night_diff_pay], ["Allowances", p.allowances], ["Other earnings", p.other_earnings]].filter(([, v]) => toCents(v) !== 0);
  // Statutory employee shares come from payroll_contributions; statutory deduction LINES duplicate them, so they are
  // skipped when contribution rows exist. Records without line detail fall back to the summary columns.
  const deductionRows = [
    ...p.contributions.map((c) => [`${AGENCY[c.agency]} (employee share)`, c.employee_share]),
    ...p.deductions.filter((x) => !(x.category === "statutory" && p.contributions.length)).map((x) => [x.description, x.amount]),
  ];
  if (!p.deductions.length) {
    if (!p.contributions.length && toCents(p.statutory_employee)) deductionRows.push(["Statutory contributions", p.statutory_employee]);
    if (toCents(p.withholding_tax)) deductionRows.push(["Withholding tax", p.withholding_tax]);
    if (toCents(p.other_deductions)) deductionRows.push(["Other deductions", p.other_deductions]);
  }

  const yE = table("Earnings", earningRows, x0, y);
  const yD = table("Deductions", deductionRows, x0 + half + 20, y);
  y = Math.max(yE, yD) + 6;

  // totals
  doc.moveTo(x0, y).lineTo(x0 + W, y).strokeColor(LINE).stroke();
  y += 10;
  const total = (label, amount, x) => {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(label, x, y, { width: half - 110 });
    doc.text(php(amount), x + half - 110, y, { width: 110, align: "right" });
  };
  total("Gross pay", p.gross_pay, x0);
  total("Total deductions", p.total_deductions, x0 + half + 20);
  y += 30;
  doc.roundedRect(x0, y, W, 46, 8).fill("#EAF1FB");
  doc.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text("NET PAY", x0 + 16, y + 17);
  doc.fontSize(18).text(php(p.net_pay), x0, y + 13, { width: W - 16, align: "right" });
  y += 66;

  // employer contributions (information only — not deducted from the employee)
  if (p.contributions.length) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY).text("Employer contributions (paid by the company, not deducted from you)", x0, y);
    y += 14;
    for (const c of p.contributions) {
      const amt = toCents(c.employer_share) + toCents(c.ec_share);
      doc.font("Helvetica").fontSize(9).fillColor(INK).text(`${AGENCY[c.agency]}${toCents(c.ec_share) ? " (incl. EC)" : ""}`, x0, y, { width: half - 100 });
      doc.text(php(fromCents(amt)), x0 + half - 100, y, { width: 100, align: "right" });
      y += 13;
    }
    y += 8;
  }
  if (toCents(p.retirement_company_share || 0) > 0) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY).text("Retirement fund (company share added to your fund, not deducted from you)", x0, y);
    y += 14;
    doc.font("Helvetica").fontSize(9).fillColor(INK).text("Company share", x0, y, { width: half - 100 });
    doc.text(php(p.retirement_company_share), x0 + half - 100, y, { width: 100, align: "right" });
    y += 21;
  }

  // footer — kept above the bottom margin so pdfkit never spills it onto a second page
  const fy = doc.page.height - doc.page.margins.bottom - 52;
  doc.moveTo(x0, fy).lineTo(x0 + W, fy).strokeColor(LINE).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(`Generated ${d(p.generated_at)}${p.released_at ? ` · Released ${d(p.released_at)}` : ""} · ${p.payslip_no}`, x0, fy + 8, { width: W })
    .text("This is a system-generated payslip from JVzPay and does not require a signature. Keep it confidential.", x0, fy + 20, { width: W })
    .text("Personal data is processed in accordance with the Data Privacy Act of 2012 (RA 10173).", x0, fy + 32, { width: W });
  doc.end();
}
