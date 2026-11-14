/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Change-password page (GET/POST /account/password), also the forced first-sign-in step.
import bcrypt from "bcrypt";
import { exec, selectOne } from "../../lib/db.js";
import { audit } from "../../lib/audit.js";
import { checkPassword } from "../../lib/validate.js";

export const passwordPage = (req, res) =>
  res.render("change-password", { title: "Change password", forced: !!req.user.must_change_password });

export const changePassword = async (req, res, next) => {
  try {
    const { current_password = "", new_password = "", confirm_password = "" } = req.body;
    const errors = {};
    const row = await selectOne("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
    if (!(await bcrypt.compare(String(current_password), row.password_hash))) errors.current_password = "Current password is incorrect.";
    const problem = checkPassword(new_password, req.user.email);
    if (problem) errors.new_password = problem;
    else if (new_password === current_password) errors.new_password = "New password must be different from the current one.";
    if (new_password !== confirm_password) errors.confirm_password = "Passwords do not match.";

    if (Object.keys(errors).length) {
      return res.status(422).render("change-password", { title: "Change password", forced: !!req.user.must_change_password, errors });
    }
    const hash = await bcrypt.hash(new_password, 12);
    await exec("UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = NOW() WHERE id = ?", [hash, req.user.id]);
    // sign out every OTHER session of this account
    await exec("DELETE FROM user_sessions WHERE user_id = ? AND sid <> ?", [req.user.id, req.sessionID]);
    await audit(req, { action: "password_changed", module: "auth", recordType: "user", recordId: req.user.id });
    req.flash("success_msg", `Password updated for ${req.user.email}. Use it the next time you sign in to this account.`);
    res.redirect("/dashboard");
  } catch (e) {
    next(e);
  }
};
