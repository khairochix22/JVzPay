// Secure single-file upload for supporting documents (passbook photo, medical certificate, …).
// Follows the XianFire upload-middleware pattern (multer, random UUID names, type allowlist) with three changes required
// for employee data: files live OUTSIDE /public (storage/uploads), the real file signature is checked (the browser-supplied
// MIME type is not trusted), and files are only served through the permission-checked /documents/:id route.
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { exec } from "../lib/db.js";
import { verifyCsrfToken } from "./csrf.js";
import { HttpError } from "../lib/errors.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UPLOAD_ROOT = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(root, "storage", "uploads");
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// signature -> [mime, extension]
const SIGNATURES = [
  { mime: "application/pdf", ext: ".pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: ".png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: ".jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
export const sniff = (buf) => SIGNATURES.find((s) => buf.length > 8 && s.test(buf)) || null;

const parser = multer({
  storage: multer.memoryStorage(), // nothing touches disk until the CSRF token and signature are verified
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 30, fieldSize: 10_000 },
});

/**
 * Parses multipart/form-data with an optional single file in `field`, then verifies the CSRF token from the parsed body.
 * Sets req.uploadError (user-facing message) instead of throwing for file problems so the form can re-render with it.
 */
export const optionalUpload = (field = "attachment") => (req, res, next) => {
  parser.single(field)(req, res, (err) => {
    if (err) {
      if (!verifyCsrfToken(req)) return next(new HttpError(403, "Your form token is invalid or has expired. Please refresh the page and try again."));
      req.uploadError = err.code === "LIMIT_FILE_SIZE" ? "The file is larger than 5 MB." : "The file could not be uploaded.";
      return next();
    }
    if (!verifyCsrfToken(req)) return next(new HttpError(403, "Your form token is invalid or has expired. Please refresh the page and try again."));
    if (req.file && req.file.size > 0) {
      const kind = sniff(req.file.buffer);
      if (!kind) { req.uploadError = "Only PDF, JPG or PNG files are accepted."; req.file = null; }
      else req.file.detected = kind;
    } else {
      req.file = null;
    }
    next();
  });
};

/** Writes a verified upload to disk and records it in document_attachments. Call inside the business transaction. */
export async function saveAttachment(req, file, ownerType, ownerId, trx) {
  if (!file?.detected) return null;
  const now = new Date();
  const rel = path.join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"));
  const dir = path.join(UPLOAD_ROOT, rel);
  fs.mkdirSync(dir, { recursive: true });
  const stored = crypto.randomUUID() + file.detected.ext;
  fs.writeFileSync(path.join(dir, stored), file.buffer, { flag: "wx" });
  const original = path.basename(String(file.originalname || "document")).replace(/[^\w.\- ()]/g, "_").slice(0, 200) || "document";
  const { insertId } = await exec(
    `INSERT INTO document_attachments (owner_type, owner_id, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [ownerType, ownerId, original, path.join(rel, stored).replace(/\\/g, "/"), file.detected.mime, file.size,
     crypto.createHash("sha256").update(file.buffer).digest("hex"), req.user.id],
    trx
  );
  return insertId;
}
