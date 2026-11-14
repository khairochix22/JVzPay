// Holidays page (GET/POST /payroll/setup/holidays): the holiday calendar is set each year from presidential proclamations (payroll.config).
import { wrap, action, badRequest } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listHolidays, saveHoliday, toggleHoliday } from "../../services/payrollSetupService.js";

const TYPES = ["regular", "special_non_working", "special_working"];
const schema = {
  holiday_date: { label: "Date", type: "date", required: true },
  name: { label: "Name", required: true, max: 120 },
  holiday_type: { label: "Type", type: "enum", values: TYPES, required: true },
};

export const page = wrap(async (req, res) => {
  const year = /^\d{4}$/.test(req.query.year || "") ? Number(req.query.year) : new Date().getFullYear();
  res.render("holidays", { title: "Holidays", year, types: TYPES, holidays: await listHolidays(year) });
});

const backYear = (req) => `/payroll/setup/holidays?year=${String(req.body.holiday_date || "").slice(0, 4) || new Date().getFullYear()}`;

export const save = action(async (req) => {
  const { values, errors, ok } = validate(req.body, schema);
  if (!ok) throw badRequest(Object.values(errors).join(" "));
  await saveHoliday(req, req.params.id ? Number(req.params.id) : null, values);
  return "Holiday saved. It applies to payroll computed after this change.";
}, backYear);

export const toggle = action(async (req) => {
  const h = await toggleHoliday(req, Number(req.params.id));
  return `${h.name} is now ${h.is_active ? "active" : "inactive"}.`;
}, "/payroll/setup/holidays");
