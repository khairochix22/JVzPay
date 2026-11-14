/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Encode Attendance page (GET/POST /attendance/encode?date=): one sheet per day for all active employees (attendance.encode).
import { wrap } from "../../lib/errors.js";
import { sheet, saveSheet, STATUSES } from "../../services/attendanceService.js";
import { lookups } from "../../services/employeeService.js";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const pickDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || "") && v <= iso(new Date()) ? v : iso(new Date()));

async function render(req, res, date, extra = {}, status = 200) {
  const raw = req.query.department || req.body?.department || "";
  const department = /^\d+$/.test(raw) ? Number(raw) : null;
  const data = await sheet(date, department);
  if (extra.posted) for (const r of data.rows) if (extra.posted[`e${r.id}`]) r.value = { ...r.value, ...extra.posted[`e${r.id}`] };
  const { departments } = await lookups();
  res.status(status).render("attendance-encode", {
    title: "Encode Attendance", date, today: iso(new Date()), department, departments, statuses: STATUSES, ...data, errors: {}, ...extra,
  });
}

export const encodeSheet = wrap((req, res) => render(req, res, pickDate(req.query.date)));

export const saveEncoding = wrap(async (req, res) => {
  const date = pickDate(req.body.date);
  const result = await saveSheet(req, date, req.body.rows);
  if (Object.keys(result.errors).length) return render(req, res, date, { errors: result.errors, posted: req.body.rows }, 422);
  const locked = result.skipped ? ` ${result.skipped} locked record(s) were left unchanged.` : "";
  req.flash("success_msg", `Saved ${result.saved} attendance record(s) for ${date}.${locked} New and edited records now await validation.`);
  const dept = req.body.department ? `&department=${encodeURIComponent(req.body.department)}` : "";
  res.redirect(`/attendance/encode?date=${date}${dept}`);
});
