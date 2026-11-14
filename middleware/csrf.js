import crypto from "crypto";

// Synchronizer-token CSRF protection. The token lives in the server-side session; every state-changing request must echo it
// (hidden `_csrf` field or `x-csrf-token` header).
//
// multipart/form-data bodies are not parsed yet at this point, so for those requests the check is DEFERRED — but only on
// the explicit allowlist below, whose routes run middleware/upload.js (which verifies the token right after parsing).
// Any other multipart request is rejected, so the deferral can never be used to skip CSRF on a normal route.
export const MULTIPART_ROUTES = [
  /^\/my\/bank\/requests$/,
  /^\/my\/leave\/applications$/,
  /^\/my\/attendance\/corrections$/,
  /^\/accounting\/income$/,
  /^\/accounting\/expenses$/,
  /^\/my\/government\/requests$/,
  /^\/my\/benefits\/dependents$/,
  /^\/my\/benefits\/enrollments$/,
  /^\/accounting\/payables\/invoices$/,
];

const isMultipart = (req) => /^multipart\/form-data/i.test(req.get("content-type") || "");

export function verifyCsrfToken(req) {
  const expected = req.session?.csrfToken;
  const sent = String(req.body?._csrf || req.get("x-csrf-token") || "");
  return !!expected && sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

export function csrf(req, res, next) {
  if (!req.session) return next(new Error("Session middleware must run before csrf"));
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.locals.csrfToken = req.session.csrfToken;

  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  if (isMultipart(req)) {
    if (MULTIPART_ROUTES.some((re) => re.test(req.path))) return next(); // verified by middleware/upload.js after parsing
    return next(Object.assign(new Error("File uploads are not accepted here."), { status: 403 }));
  }
  if (!verifyCsrfToken(req)) {
    const err = new Error("Your session form token is invalid or has expired. Please go back, refresh the page, and try again.");
    err.status = 403;
    return next(err);
  }
  next();
}
