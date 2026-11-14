import session from "express-session";
import { exec, selectOne } from "../lib/db.js";

// MySQL-backed session store on the `user_sessions` table (survives restarts; lets admins see/kill sessions).
export class MysqlSessionStore extends session.Store {
  constructor({ idleMs, cleanupMs = 15 * 60 * 1000 }) {
    super();
    this.idleMs = idleMs;
    this.timer = setInterval(() => {
      exec("DELETE FROM user_sessions WHERE expires_at < NOW()").catch(() => {});
    }, cleanupMs);
    this.timer.unref();
  }

  expiry(sess) {
    return sess?.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + this.idleMs);
  }

  get(sid, cb) {
    selectOne("SELECT data FROM user_sessions WHERE sid = ? AND expires_at > NOW()", [sid])
      .then((row) => cb(null, row ? JSON.parse(row.data) : null))
      .catch(cb);
  }

  set(sid, sess, cb) {
    exec(
      `INSERT INTO user_sessions (sid, user_id, data, expires_at, ip_address, user_agent)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), data = VALUES(data), expires_at = VALUES(expires_at)`,
      [sid, sess.userId ?? null, JSON.stringify(sess), this.expiry(sess), sess.ip ?? null, sess.ua ?? null]
    ).then(() => cb && cb(null)).catch((e) => cb && cb(e));
  }

  touch(sid, sess, cb) {
    exec("UPDATE user_sessions SET expires_at = ? WHERE sid = ?", [this.expiry(sess), sid])
      .then(() => cb && cb(null)).catch((e) => cb && cb(e));
  }

  destroy(sid, cb) {
    exec("DELETE FROM user_sessions WHERE sid = ?", [sid]).then(() => cb && cb(null)).catch((e) => cb && cb(e));
  }
}
