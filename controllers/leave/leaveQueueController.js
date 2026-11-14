/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Leave Requests queue page (GET /leave-requests): pending and past applications (leave.view; decisions need leave.review).
import { wrap } from "../../lib/errors.js";
import { leaveQueue } from "../../services/leaveAdminService.js";

export const queue = wrap(async (req, res) => {
  res.render("leave-queue", { title: "Leave Requests", ...(await leaveQueue(req)), canDecide: req.user.can("leave.review") });
});
