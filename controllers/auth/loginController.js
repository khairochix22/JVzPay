/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Sign-in page (GET/POST /login) and sign-out (POST /logout).
import bcrypt from "bcrypt";
import { env } from "../../config/env.js";
import { exec, selectOne } from "../../lib/db.js";
import { audit } from "../../lib/audit.js";
import { requestStatusForLogin } from "../../services/accountRequestService.js";

// A real bcrypt hash of a random string: compared when the email is unknown so response time doesn't reveal accounts.
const DUMMY_HASH = bcrypt.hashSync("jvzpay-timing-equaliser", 12);
const GENERIC_FAIL = "Invalid email or password, or the account is temporarily locked.";

export const loginPage = (req, res) =>
  res.render("login", { title: "Sign in", layoutBare: true, expired: req.query.expired === "1", idleMinutes: env.sessionIdleMinutes });

const safeReturnTo = (url) => (typeof url === "string" && /^\/(?!\/)[\w\-/?=&%.]*$/.test(url) && !url.startsWith("/login") ? url : "/dashboard");

export const loginUser = async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const fail = async (user, action) => {
      await audit(req, { action, module: "auth", recordType: "user", recordId: user?.id, next: { email }, actor: user ? { id: user.id, full_name: user.full_name } : null });
      res.status(401).render("login", { title: "Sign in", layoutBare: true, email, formError: GENERIC_FAIL });
    };

    if (!email || !password || password.length > 200) return fail(null, "login_failed");

    const user = await selectOne(
      "SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ? AND u.deleted_at IS NULL",
      [email]
    );
    if (!user) {
      const requestStatus = await requestStatusForLogin(email, password);
      if (requestStatus) return res.status(401).render("login", { title: "Sign in", layoutBare: true, email, formError: requestStatus });
      await bcrypt.compare(password, DUMMY_HASH);
      return fail(null, "login_failed");
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await bcrypt.compare(password, DUMMY_HASH);
      return fail(user, "login_blocked_locked");
    }
    if (user.status !== "active") {
      await bcrypt.compare(password, DUMMY_HASH);
      return fail(user, "login_blocked_inactive");
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const attempts = user.failed_login_attempts + 1;
      if (attempts >= env.maxFailedLogins) {
        await exec(
          "UPDATE users SET failed_login_attempts = 0, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?",
          [env.lockoutMinutes, user.id]
        );
        await audit(req, { action: "account_locked", module: "auth", recordType: "user", recordId: user.id, remarks: `Locked for ${env.lockoutMinutes} minutes after ${attempts} failed attempts`, actor: { id: user.id, full_name: user.full_name } });
      } else {
        await exec("UPDATE users SET failed_login_attempts = ? WHERE id = ?", [attempts, user.id]);
      }
      return fail(user, "login_failed");
    }

    await exec(
      "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = ? WHERE id = ?",
      [String(req.ip || "").slice(0, 45), user.id]
    );
    const returnTo = safeReturnTo(req.session.returnTo);

    // New session id on privilege change prevents session fixation
    req.session.regenerate(async (err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.createdAt = Date.now();
      req.session.ip = String(req.ip || "").slice(0, 45);
      req.session.ua = (req.get("user-agent") || "").slice(0, 255);
      req.session.save(async (saveErr) => {
        if (saveErr) return next(saveErr);
        await audit(req, { action: "login", module: "auth", recordType: "user", recordId: user.id, actor: { id: user.id, full_name: user.full_name, role_code: user.role_code } });
        res.redirect(user.must_change_password ? "/account/password" : returnTo);
      });
    });
  } catch (e) {
    next(e);
  }
};

export const logoutUser = async (req, res, next) => {
  try {
    if (req.user) await audit(req, { action: "logout", module: "auth", recordType: "user", recordId: req.user.id });
    req.session.destroy(() => {
      res.clearCookie("jvzpay.sid");
      res.redirect("/login");
    });
  } catch (e) {
    next(e);
  }
};
