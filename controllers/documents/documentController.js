/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// GET /documents/:id — authorised access to uploaded documents (stored outside /public).
// Access = the employee who owns the request, or a reviewer holding the module's permission. Non-owner views are audited.
import path from "node:path";
import fs from "node:fs";
import { selectOne } from "../../lib/db.js";
import { audit } from "../../lib/audit.js";
import { wrap, HttpError } from "../../lib/errors.js";
import { UPLOAD_ROOT } from "../../middleware/upload.js";

const OWNERS = {
  bank_enrollment_request: { table: "bank_enrollment_requests", perms: ["bank.review"] },
  leave_application: { table: "leave_applications", perms: ["leave.view", "leave.review"] },
  accounting_transaction: { table: "accounting_transactions", perms: ["accounting.view", "accounting.prepare"], noEmployee: true },
  attendance_correction_request: { table: "attendance_correction_requests", perms: ["attendance.correction.review", "attendance.view"] },
  statutory_enrollment: { table: "statutory_enrollments", perms: ["statutory.review"] },
  dependent_enrollment: { table: "dependent_enrollments", perms: ["benefits.review"] },
  benefit_enrollment: { table: "benefit_enrollment_references", perms: ["benefits.review"] },
  supplier_invoice: { table: "supplier_invoices", perms: ["payables.prepare", "payables.approve"], noEmployee: true },
};

export const download = wrap(async (req, res) => {
  const doc = await selectOne("SELECT * FROM document_attachments WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  const owner = doc && OWNERS[doc.owner_type];
  if (!doc || !owner) throw new HttpError(404, "Document not found.");
  const parent = await selectOne(`SELECT ${owner.noEmployee ? "NULL" : "employee_id"} AS employee_id FROM ${owner.table} WHERE id = ?`, [doc.owner_id]); // table name from the fixed map above
  const isOwner = parent && parent.employee_id !== null && parent.employee_id === req.user.employee_id;
  const isReviewer = owner.perms.some((p) => req.user.can(p));
  if (!isOwner && !isReviewer) throw new HttpError(403, "You do not have access to this document.");

  const file = path.resolve(UPLOAD_ROOT, doc.stored_name);
  if (!file.startsWith(path.resolve(UPLOAD_ROOT) + path.sep) || !fs.existsSync(file)) throw new HttpError(404, "The file is no longer available.");
  if (!isOwner) await audit(req, { action: "document_viewed", module: "documents", recordType: doc.owner_type, recordId: doc.owner_id, remarks: doc.original_name });

  res.setHeader("Content-Type", doc.mime_type); // detected from the file signature at upload, never the client's claim
  res.setHeader("Content-Disposition", `inline; filename="${doc.original_name.replace(/["\\\r\n]/g, "_")}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(file);
});
