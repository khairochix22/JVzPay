/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Leave Calendar page (GET /leave-calendar?month=YYYY-MM): approved and pending leave per day (leave.view).
import { wrap } from "../../lib/errors.js";
import { calendar } from "../../services/leaveAdminService.js";
import { lookups } from "../../services/employeeService.js";

export const calendarPage = wrap(async (req, res) => {
  const { departments } = await lookups();
  res.render("leave-calendar", { title: "Leave Calendar", ...(await calendar(req)), departments });
});
