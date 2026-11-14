/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Attendance Records page (GET /attendance): all employees' daily records with filters (attendance.view).
import { wrap } from "../../lib/errors.js";
import { listRecords, STATUSES } from "../../services/attendanceService.js";
import { lookups } from "../../services/employeeService.js";

export const records = wrap(async (req, res) => {
  const data = await listRecords(req);
  const { departments } = await lookups();
  res.render("attendance-records", { title: "Attendance Records", ...data, departments, statuses: STATUSES });
});
