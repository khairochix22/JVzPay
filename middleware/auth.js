import { select, selectOne } from "../lib/db.js";
import { HttpError } from "../lib/errors.js";
import { getSetting } from "../lib/settings.js";

// ---- role -> permission cache (short TTL; cleared whenever an Accounting Supervisor changes grants) --------------------------
const permCache = new Map(); // roleId -> { at, set }
const TTL = 30_000;
export const clearPermissionCache = () => permCache.clear();

async function permissionsFor(roleId) {
  const hit = permCache.get(roleId);
  if (hit && Date.now() - hit.at < TTL) return hit.set;
  const rows = await select(
    "SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?",
    [roleId]
  );
  const set = new Set(rows.map((r) => r.code));
  permCache.set(roleId, { at: Date.now(), set });
  return set;
}

const MAX_SESSION_AGE_MS = 12 * 60 * 60 * 1000; // absolute lifetime regardless of activity

/**
 * Loads req.user from the session on every request (so deactivated/locked users lose access immediately,
 * and role changes apply without re-login). Never trusts anything stored in the cookie except the user id.
 */
export async function loadUser(req, res, next) {
  try {
    req.user = null;
    const id = req.session?.userId;
    if (!id) return next();

    if (req.session.createdAt && Date.now() - req.session.createdAt > MAX_SESSION_AGE_MS) {
      return req.session.destroy(() => next());
    }
    const u = await selectOne(
      `SELECT u.id, u.email, u.full_name, u.status, u.must_change_password, u.privacy_ack_version, u.employee_id, u.role_id,
              r.code AS role_code, r.name AS role_name,
              e.employee_no, e.first_name,
              -- leads a team: HR named this employee as someone's immediate supervisor, or a first approval waits for them
              (e.hr_employee_id IS NOT NULL AND EXISTS (SELECT 1 FROM employees t WHERE t.supervisor_hr_id = e.hr_employee_id AND t.deleted_at IS NULL
                 AND t.employment_status IN ('active','on_leave'))) OR EXISTS (SELECT 1 FROM leave_applications x WHERE x.supervisor_user_id = u.id AND x.supervisor_status = 'pending')
                 OR EXISTS (SELECT 1 FROM overtime_records x WHERE x.supervisor_user_id = u.id AND x.supervisor_status = 'pending')
                 OR EXISTS (SELECT 1 FROM attendance_correction_requests x WHERE x.supervisor_user_id = u.id AND x.supervisor_status = 'pending')
                 OR EXISTS (SELECT 1 FROM leave_conversions x WHERE x.supervisor_user_id = u.id AND x.supervisor_status = 'pending') AS leads_team
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN employees e ON e.id = u.employee_id
        WHERE u.id = ? AND u.deleted_at IS NULL`,
      [id]
    );
    if (!u || u.status !== "active") {
      return req.session.destroy(() => next());
    }
    u.permissions = await permissionsFor(u.role_id);
    // Team Approvals is for immediate supervisors and team leaders (and Accounting Supervisors, the first approvers of
    // Payroll/Accounting employees with no supervisor on record) — not for every Self-Service user
    if (u.role_code === "accounting_supervisor" || Number(u.leads_team)) u.permissions = new Set([...u.permissions, "team.approve"]);
    u.privacyAckNeeded = u.privacy_ack_version !== String(await getSetting("privacy.notice_version", "1"));
    u.can = (code) => u.permissions.has(code);
    u.canAny = (...codes) => codes.some((c) => u.permissions.has(c));
    req.user = u;
    next();
  } catch (e) {
    next(e);
  }
}

const wantsJson = (req) => req.xhr || /application\/json/.test(req.get("accept") || "") || req.path === "/session/keepalive";
// pages a signed-in user may still open before acknowledging the privacy notice
const PRIVACY_FREE = /^\/(privacy|logout|account\/password|session\/keepalive|activity\/print)/;

export function requireAuth(req, res, next) {
  if (!req.user) {
    if (wantsJson(req)) return res.status(401).json({ error: "Sign in required." });
    if (req.method === "GET") req.session.returnTo = req.originalUrl;
    return res.redirect("/login");
  }
  // Force a password change before anything else
  if (req.user.must_change_password && !req.path.startsWith("/account/password") && req.path !== "/logout") {
    return res.redirect("/account/password");
  }
  // Then the privacy notice, once per notice version
  const url = req.originalUrl.split("?")[0];
  if (req.user.privacyAckNeeded && !PRIVACY_FREE.test(url)) {
    if (req.method === "GET") req.session.returnTo = req.originalUrl;
    return res.redirect("/privacy/acknowledge");
  }
  next();
}

// Server-side permission gate. All listed permissions are required; use requireAny for "one of".
export const requirePermission = (...codes) => (req, res, next) => {
  if (!req.user) return res.redirect("/login");
  if (codes.every((c) => req.user.permissions.has(c))) return next();
  next(new HttpError(403, "You do not have permission to access this page."));
};

export const requireAny = (...codes) => (req, res, next) => {
  if (!req.user) return res.redirect("/login");
  if (codes.some((c) => req.user.permissions.has(c))) return next();
  next(new HttpError(403, "You do not have permission to access this page."));
};

// Self-service routes need a linked employee record (e.g. an Accounting Supervisor account may have none).
export const requireEmployeeLink = (req, res, next) => {
  if (!req.user?.employee_id) {
    return next(new HttpError(403, "Your account is not linked to an employee record. Ask an administrator to link it."));
  }
  next();
};

export const guestOnly = (req, res, next) => (req.user ? res.redirect("/dashboard") : next());

