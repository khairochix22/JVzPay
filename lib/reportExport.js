// Renders a report (columns + rows) to Excel or PDF. The same data drives the on-screen table, so all three always agree.
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { pdfText } from "../services/payslipService.js";
import { toCents, fromCents } from "./money.js";
import { brandImage, FULL_LOGO_RATIO } from "./brand.js";

const NAVY = "142B4A";
const moneyFmt = (v) => {
  if (v === null || v === undefined || v === "") return "";
  const c = toCents(v);
  const [w, f] = fromCents(Math.abs(c)).split(".");
  return `${c < 0 ? "-" : ""}${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
};
const cell = (col, v) => (v === null || v === undefined ? "" : col.type === "money" ? moneyFmt(v) : (col.type === "date" ? String(v).slice(0, 10) : String(v)));

export async function toXlsx(def, data, company, res) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "JVzPay";
  const ws = wb.addWorksheet(def.title.slice(0, 31));
  ws.addRow([company]).font = { bold: true, size: 13 };
  ws.addRow([def.title]).font = { bold: true, size: 12 };
  if (data.subtitle) ws.addRow([data.subtitle]);
  ws.addRow([]);
  const head = ws.addRow(data.columns.map((c) => c.label));
  head.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${NAVY}` } }; });
  for (const r of data.rows) {
    const row = ws.addRow(data.columns.map((c, i) => {
      const v = r[c.key];
      if (r._kind === "heading") return i === 0 ? v : null;
      if (v === null || v === undefined || v === "") return null;
      if (c.type === "money") return toCents(v) / 100;
      if (c.type === "num") return Number(v);
      return c.type === "date" ? String(v).slice(0, 10) : v;
    }));
    data.columns.forEach((c, i) => { if (c.type === "money") row.getCell(i + 1).numFmt = "#,##0.00"; });
    if (r._kind) row.font = { bold: true };
  }
  for (const n of data.notes || []) ws.addRow([n]).font = { italic: true };
  ws.columns.forEach((col, i) => {
    const c = data.columns[i];
    const longest = Math.max(c ? c.label.length : 8, ...data.rows.map((r) => String(c ? r[c.key] ?? "" : "").length));
    col.width = Math.min(46, Math.max(10, longest + 2));
  });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${def.key}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

export function toPdf(def, data, company, address, res) {
  const landscape = data.columns.length > 5;
  const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 36, bufferPages: true, info: { Title: def.title, Author: company } });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${def.key}.pdf"`);
  doc.pipe(res);
  const W = doc.page.width - 72, x0 = 36, bottom = () => doc.page.height - 50;

  // column widths proportional to content, with sensible minimums
  const weights = data.columns.map((c) => {
    const longest = Math.max(c.label.length, ...data.rows.filter((r) => !r._kind || r._kind !== "heading").map((r) => cell(c, r[c.key]).length));
    return Math.min(c.type === "money" ? 14 : 34, Math.max(c.type === "money" ? 10 : 6, longest));
  });
  const totalW = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / totalW) * W);
  const fs = data.columns.length > 9 ? 7.5 : 8.5;

  // JohnVivz logo at the top right of every page; the heading text keeps clear of it
  const logo = brandImage("full");
  const logoW = logo ? 80 : 0, logoH = logo ? logoW / FULL_LOGO_RATIO : 0;
  const tw = logo ? W - logoW - 14 : W;
  const header = () => {
    if (logo) doc.image(logo, x0 + W - logoW, 30, { width: logoW });
    doc.font("Helvetica-Bold").fontSize(14).fillColor(`#${NAVY}`).text(pdfText(company), x0, 36, { width: tw });
    doc.font("Helvetica").fontSize(8.5).fillColor("#64748B").text(pdfText(address), x0, doc.y, { width: tw });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#1E293B").text(pdfText(def.title), x0, doc.y + 8, { width: tw });
    if (data.subtitle) doc.font("Helvetica").fontSize(9).fillColor("#64748B").text(pdfText(data.subtitle), x0, doc.y + 1, { width: tw });
    let y = Math.max(doc.y + 8, 30 + logoH + 8), x = x0;
    doc.rect(x0, y, W, 18).fill(`#${NAVY}`);
    data.columns.forEach((c, i) => {
      doc.font("Helvetica-Bold").fontSize(fs).fillColor("#FFFFFF").text(pdfText(c.label), x + 3, y + 5, { width: widths[i] - 6, align: c.type === "money" || c.type === "num" ? "right" : "left", lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    return y + 20;
  };

  let y = header();
  if (!data.rows.length) doc.font("Helvetica").fontSize(10).fillColor("#64748B").text("No data for the selected filters.", x0, y + 8);
  for (const r of data.rows) {
    doc.font(r._kind ? "Helvetica-Bold" : "Helvetica").fontSize(fs);
    const texts = data.columns.map((c, i) => (r._kind === "heading" ? (i === 0 ? r[c.key] : "") : cell(c, r[c.key])));
    const h = r._kind === "heading" ? 15 : Math.max(13, ...texts.map((t, i) => doc.heightOfString(pdfText(t), { width: widths[i] - 6 }) + 4));
    if (y + h > bottom()) { doc.addPage(); y = header(); doc.font(r._kind ? "Helvetica-Bold" : "Helvetica").fontSize(fs); }
    if (r._kind === "heading") { doc.rect(x0, y, W, h).fill("#EAF1FB"); doc.fillColor(`#${NAVY}`).font("Helvetica-Bold").text(pdfText(texts[0]), x0 + 3, y + 4, { width: W - 6, lineBreak: false }); y += h; continue; }
    let x = x0;
    doc.fillColor("#1E293B");
    data.columns.forEach((c, i) => {
      doc.text(pdfText(texts[i]), x + 3, y + 2, { width: widths[i] - 6, align: c.type === "money" || c.type === "num" ? "right" : "left" });
      x += widths[i];
    });
    y += h;
    doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(r._kind === "grand" ? 1 : 0.4).strokeColor(r._kind === "grand" ? `#${NAVY}` : "#E2E8F0").stroke();
  }
  doc.font("Helvetica-Oblique").fontSize(8).fillColor("#64748B");
  for (const n of data.notes || []) { if (y + 14 > bottom()) { doc.addPage(); y = 40; } doc.text(pdfText(n), x0, y + 6, { width: W }); y = doc.y; }
  // page numbers (added last so the total is known); margins lifted so pdfkit does not paginate the footer
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7.5).fillColor("#94A3B8").text(`Generated by JVzPay on ${new Date().toLocaleDateString("en-PH")} · Page ${i + 1} of ${range.count}`, x0, doc.page.height - 30, { width: W, align: "right", lineBreak: false });
    doc.page.margins.bottom = saved;
  }
  doc.end();
}
