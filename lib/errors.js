export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const forbidden = (msg = "You do not have permission to perform this action.") => new HttpError(403, msg);
export const notFound = (msg = "The requested record was not found.") => new HttpError(404, msg);
export const badRequest = (msg, details) => new HttpError(400, msg, details);

// Wraps async route handlers so rejected promises reach the error middleware.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// POST action helper: runs fn, flashes its returned message (or the user-facing error), then redirects to `back`.
// 403s are re-thrown so forbidden actions always reach the error page.
export const action = (fn, back) => wrap(async (req, res) => {
  try {
    const msg = await fn(req, res);
    if (msg) req.flash("success_msg", msg);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500 || e.status === 403) {
      const db = dbMessage(e);
      if (!db) throw e;
      req.flash("error_msg", db);
      return res.redirect(typeof back === "function" ? back(req) : back);
    }
    req.flash("error_msg", e.message);
  }
  res.redirect(typeof back === "function" ? back(req) : back);
});

// MySQL errors raised by our integrity triggers (SQLSTATE 45000) carry a safe, human-readable message.
export const dbMessage = (err) => {
  const orig = err?.original || err;
  if (orig?.sqlState === "45000") return orig.sqlMessage;
  if (orig?.code === "ER_DUP_ENTRY") return "A record with the same unique value already exists.";
  if (orig?.code === "ER_CHECK_CONSTRAINT_VIOLATED") return "The values violate a data integrity rule.";
  if (orig?.code === "ER_ROW_IS_REFERENCED_2") return "This record is referenced by other records and cannot be removed.";
  return null;
};
