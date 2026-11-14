/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Notifications page (GET /notifications). Every query is scoped to user_id = req.user.id.
import { select, scalar, exec } from "../../lib/db.js";
import { wrap } from "../../lib/errors.js";
import { tableState, tableMeta } from "../../lib/paginate.js";

export const list = wrap(async (req, res) => {
  const t = tableState(req, { sortable: { time: "id" }, defaultSort: "time", defaultDir: "desc", perPage: 20 });
  const unreadOnly = req.query.filter === "unread";
  const where = `user_id = ?${unreadOnly ? " AND is_read = 0" : ""}`;
  const total = Number(await scalar(`SELECT COUNT(*) FROM notifications WHERE ${where}`, [req.user.id]));
  const rows = await select(`SELECT * FROM notifications WHERE ${where} ORDER BY id DESC LIMIT ${t.limit} OFFSET ${t.offset}`, [req.user.id]);
  res.render("notifications", { title: "Notifications", rows, unreadOnly, meta: tableMeta(req, t, total, { filter: unreadOnly ? "unread" : undefined }) });
});

export const markRead = wrap(async (req, res) => {
  const row = (await select("SELECT link_url FROM notifications WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]))[0];
  await exec("UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND user_id = ? AND is_read = 0", [req.params.id, req.user.id]);
  // only follow internal links
  res.redirect(row?.link_url && /^\/(?!\/)/.test(row.link_url) ? row.link_url : "/notifications");
});

export const markAllRead = wrap(async (req, res) => {
  await exec("UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0", [req.user.id]);
  req.flash("success_msg", "All notifications marked as read.");
  res.redirect("/notifications");
});
