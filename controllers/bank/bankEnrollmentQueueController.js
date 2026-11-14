/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Bank Enrollments queue page (GET /bank-enrollments).
import { wrap } from "../../lib/errors.js";
import * as bank from "../../services/bankService.js";

export const queue = wrap(async (req, res) => {
  res.render("bank-reviews", { title: "Bank Enrollments", ...(await bank.listRequests(req)) });
});
