/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Attendance Corrections queue page (GET /attendance/corrections) for the Accounting Supervisor.
import { wrap } from "../../lib/errors.js";
import { correctionQueue } from "../../services/attendanceService.js";

export const queue = wrap(async (req, res) => {
  res.render("correction-queue", { title: "Attendance Corrections", ...(await correctionQueue(req)) });
});
