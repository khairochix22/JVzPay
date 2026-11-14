// Password reset links: an Accounting Supervisor creates a one-time link for a person, who then chooses their own password.
// The link expires (RESET_LINK_MINUTES, default 30), works once, and only its SHA-256 is stored. There is no email
// service yet, so the Accounting Supervisor passes the link on; nobody but the person ever knows the new password.
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { selectOne, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { checkPassword } from "../lib/validate.js";
import { badRequest, notFound } from "../lib/errors.js";
import { env } from "../config/env.js";

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

export async function createResetLink(req, userId) {
  const user = await selectOne("SELECT id, email, status FROM users WHERE id = ? AND deleted_at IS NULL", [userId]);
  if (!user) throw notFound("User not found.");
  if (user.status !== "active") throw badRequest("Activate the account before sending a reset link.");
  if (user.id === req.user.id) throw badRequest("Use Change password for your own account.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = await tx(async (trx) => {
    await exec("UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL", [user.id], trx); // older links stop working
    await exec("INSERT INTO password_resets (user_id, token_hash, expires_at, created_by, ip_address) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, ?)",
      [user.id, sha256(token), env.resetLinkMinutes, req.user.id, String(req.ip || "").slice(0, 45)], trx);
    await audit(req, { action: "password_reset_link_created", module: "users", recordType: "user", recordId: user.id, remarks: `Expires in ${env.resetLinkMinutes} minutes; usable once.` }, trx);
    return (await selectOne("SELECT expires_at FROM password_resets WHERE token_hash = ?", [sha256(token)], trx)).expires_at;
  });
  return { url: `${req.protocol}://${req.get("host")}/reset-password/${token}`, expiresAt, email: user.email };
}

/** The reset row for a token, or null when it is unknown, used, expired or the account is no longer active. */
export async function findValidReset(token, trx = null) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(String(token || ""))) return null;
  return selectOne(
    `SELECT pr.id, pr.user_id, pr.expires_at, u.email, u.full_name FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW() AND u.status = 'active' AND u.deleted_at IS NULL ${trx ? "FOR UPDATE" : ""}`,
    [sha256(token)], trx);
}

export async function completeReset(req, token, password, confirm) {
  const errors = {};
  const reset = await findValidReset(token);
  if (!reset) return { invalid: true };
  const problem = checkPassword(String(password || ""), reset.email);
  if (problem) errors.new_password = problem;
  if (password !== confirm) errors.confirm_password = "Passwords do not match.";
  if (Object.keys(errors).length) return { errors, reset };
  const hash = await bcrypt.hash(String(password), 12);
  const done = await tx(async (trx) => {
    const r = await findValidReset(token, trx);
    if (!r) return false;
    await exec("UPDATE users SET password_hash = ?, must_change_password = 0, failed_login_attempts = 0, locked_until = NULL, password_changed_at = NOW() WHERE id = ?", [hash, r.user_id], trx);
    await exec("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [r.id], trx);
    await exec("DELETE FROM user_sessions WHERE user_id = ?", [r.user_id], trx);
    await audit(req, { action: "password_reset_completed", module: "auth", recordType: "user", recordId: r.user_id, actor: { id: r.user_id, full_name: r.full_name } }, trx);
    return true;
  });
  return done ? { ok: true, email: reset.email } : { invalid: true };
}
