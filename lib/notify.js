import { exec, select } from "./db.js";

// Create an in-app notification for one user.
export async function notify(userId, { type, title, message, relatedType = null, relatedId = null, link = null }, trx = null) {
  if (!userId) return;
  await exec(
    `INSERT INTO notifications (user_id, type, title, message, related_type, related_id, link_url)
     VALUES (?,?,?,?,?,?,?)`,
    [userId, type, title.slice(0, 160), message.slice(0, 500), relatedType, relatedId, link],
    trx
  );
}

export async function notifyMany(userIds, payload, trx = null) {
  for (const id of new Set(userIds.filter(Boolean))) await notify(id, payload, trx);
}

// Notify every active user whose role holds the permission (e.g. all payroll supervisors).
export async function notifyPermission(permissionCode, payload, { excludeUserId = null } = {}, trx = null) {
  const rows = await select(
    `SELECT DISTINCT u.id FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE p.code = ? AND u.status = 'active' AND u.deleted_at IS NULL`,
    [permissionCode],
    trx
  );
  await notifyMany(rows.map((r) => r.id).filter((id) => id !== excludeUserId), payload, trx);
}

// Notify the login account of an employee, if one exists.
export async function notifyEmployee(employeeId, payload, trx = null) {
  const rows = await select("SELECT id FROM users WHERE employee_id = ? AND deleted_at IS NULL", [employeeId], trx);
  await notifyMany(rows.map((r) => r.id), payload, trx);
}
