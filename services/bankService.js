// Bank account enrollment (Module 6).
// Employee submits → validation → Accounting Supervisor approves/rejects → employee notified → approved details become the
// single active payroll account. Enrollment NEVER moves money: transfers need a separately authorised banking integration.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { encrypt, decrypt, maskNumber } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { notifyEmployee, notifyPermission } from "../lib/notify.js";
import { nextDocNo } from "../lib/sequence.js";
import { validate } from "../lib/validate.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { saveAttachment } from "../middleware/upload.js";
import { tableState, tableMeta, likeTerm } from "../lib/paginate.js";
import { fullName } from "./employeeService.js";

export const BANKS = [
  "LANDBANK", "BDO Unibank", "Bank of the Philippine Islands (BPI)", "Metrobank", "Philippine National Bank (PNB)",
  "Security Bank", "UnionBank", "RCBC", "China Bank", "Development Bank of the Philippines (DBP)", "EastWest Bank",
  "GCash", "Maya", "Other",
];
export const ACCOUNT_TYPES = ["savings", "checking", "payroll_card", "e_wallet"];

const lettersOnly = (s) => String(s || "").toUpperCase().replace(/[^A-Z]/g, "");
// The holder name "matches" when it contains the employee's first and last name (order/middle name may differ).
export const holderMatches = (holder, emp) => {
  const h = lettersOnly(holder);
  return h.includes(lettersOnly(emp.first_name)) && h.includes(lettersOnly(emp.last_name));
};

export function validateBankInput(body, emp, hasFile) {
  const { values, errors } = validate(body, {
    bank_name: { label: "Bank", type: "enum", values: BANKS, required: true },
    bank_name_other: { label: "Bank name", max: 100 },
    account_holder_name: { label: "Account holder name", required: true, max: 160 },
    account_number: { label: "Account number", required: true, max: 40 },
    account_number_confirm: { label: "Confirm account number", required: true, max: 40 },
    account_type: { label: "Account type", type: "enum", values: ACCOUNT_TYPES, required: true },
  });
  if (values.bank_name === "Other") {
    if (!values.bank_name_other) errors.bank_name_other = "Enter the name of the bank.";
    values.bank = values.bank_name_other;
  } else values.bank = values.bank_name;

  const digits = String(values.account_number || "").replace(/[\s-]/g, "");
  const confirm = String(values.account_number_confirm || "").replace(/[\s-]/g, "");
  if (values.account_number && !/^\d+$/.test(digits)) errors.account_number = "Account number may contain digits only (spaces and dashes are ignored).";
  else if (values.account_number) {
    if (values.account_type === "e_wallet" && !/^09\d{9}$/.test(digits)) errors.account_number = "E-wallet accounts must be an 11-digit mobile number starting with 09.";
    else if (values.account_type !== "e_wallet" && (digits.length < 10 || digits.length > 19)) errors.account_number = "Bank account numbers must have 10 to 19 digits.";
  }
  if (!errors.account_number && values.account_number_confirm && digits !== confirm) errors.account_number_confirm = "The account numbers do not match.";
  if (values.bank_name === "GCash" || values.bank_name === "Maya") {
    if (values.account_type !== "e_wallet") errors.account_type = "GCash and Maya accounts must use the E-wallet type.";
  }
  values.digits = digits;
  values.nameMismatch = !!values.account_holder_name && !holderMatches(values.account_holder_name, emp);
  if (values.nameMismatch && !hasFile) {
    errors.attachment = "The account holder name differs from your employee record. Attach proof that the account is yours (e.g. passbook or bank certificate).";
  }
  return { values, errors };
}

// ---- employee side ------------------------------------------------------------------------------------------------------
export async function myBank(employeeId) {
  const [active, pending, requests, accounts] = await Promise.all([
    selectOne("SELECT id, bank_name, account_holder_name, account_last4, account_type, approved_at FROM bank_accounts WHERE employee_id = ? AND active_flag = 1", [employeeId]),
    selectOne("SELECT * FROM bank_enrollment_requests WHERE employee_id = ? AND status = 'pending'", [employeeId]),
    select(
      `SELECT r.id, r.request_no, r.request_type, r.bank_name, r.account_last4, r.account_type, r.status, r.submitted_at, r.decided_at,
              r.decision_remarks, u.full_name AS decided_by_name
         FROM bank_enrollment_requests r LEFT JOIN users u ON u.id = r.decided_by
        WHERE r.employee_id = ? ORDER BY r.id DESC LIMIT 20`, [employeeId]),
    select("SELECT bank_name, account_last4, account_type, status, approved_at, superseded_at FROM bank_accounts WHERE employee_id = ? ORDER BY id DESC", [employeeId]),
  ]);
  return { active, pending, requests, accounts };
}

export async function submitRequest(req, values, file) {
  const employeeId = req.user.employee_id;
  return tx(async (trx) => {
    // serialise per employee so two tabs can't create two pending requests
    const emp = await selectOne("SELECT id, first_name, last_name FROM employees WHERE id = ? AND deleted_at IS NULL FOR UPDATE", [employeeId], trx);
    if (!emp) throw notFound("Employee record not found.");
    if (await scalar("SELECT COUNT(*) FROM bank_enrollment_requests WHERE employee_id = ? AND status = 'pending'", [employeeId], trx)) {
      throw badRequest("You already have a pending bank enrollment request. Cancel it or wait for the decision before submitting another.");
    }
    const hasActive = !!(await scalar("SELECT COUNT(*) FROM bank_accounts WHERE employee_id = ? AND active_flag = 1", [employeeId], trx));
    const requestNo = await nextDocNo("BER", 4, trx);
    const { insertId } = await exec(
      `INSERT INTO bank_enrollment_requests (request_no, employee_id, request_type, bank_name, account_holder_name, account_number_enc,
         account_last4, account_type, submitted_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [requestNo, employeeId, hasActive ? "update" : "new", values.bank, values.account_holder_name, encrypt(values.digits),
       values.digits.slice(-4), values.account_type, req.user.id],
      trx
    );
    const docId = await saveAttachment(req, file, "bank_enrollment_request", insertId, trx);
    if (docId) await exec("UPDATE bank_enrollment_requests SET attachment_id = ? WHERE id = ?", [docId, insertId], trx);
    await audit(req, {
      action: "bank_enrollment_submitted", module: "bank", recordType: "bank_enrollment_request", recordId: insertId,
      next: { request_no: requestNo, type: hasActive ? "update" : "new", bank: values.bank, account: `••••${values.digits.slice(-4)}`, account_type: values.account_type, name_mismatch: values.nameMismatch },
    }, trx);
    await notifyPermission("bank.review", {
      type: "bank_enrollment_submitted", title: "Bank enrollment awaiting review",
      message: `${fullName(emp)} submitted ${requestNo} (${values.bank}, account ending ${values.digits.slice(-4)}).`,
      relatedType: "bank_enrollment_request", relatedId: insertId, link: `/bank-enrollments/${insertId}`,
    }, { excludeUserId: req.user.id }, trx);
    return { id: insertId, requestNo };
  });
}

export async function cancelRequest(req, requestId) {
  return tx(async (trx) => {
    const r = await selectOne("SELECT * FROM bank_enrollment_requests WHERE id = ? FOR UPDATE", [requestId], trx);
    if (!r || r.employee_id !== req.user.employee_id) throw notFound("Request not found.");
    if (r.status !== "pending") throw badRequest("Only pending requests can be cancelled.");
    await exec("UPDATE bank_enrollment_requests SET status = 'cancelled' WHERE id = ?", [requestId], trx);
    await audit(req, { action: "bank_enrollment_cancelled", module: "bank", recordType: "bank_enrollment_request", recordId: requestId }, trx);
  });
}

// ---- reviewer side ------------------------------------------------------------------------------------------------------
export async function listRequests(req) {
  const t = tableState(req, { sortable: { submitted: "r.submitted_at", employee: "e.last_name", status: "r.status" }, defaultSort: "submitted", defaultDir: "asc" });
  const status = ["pending", "approved", "rejected", "cancelled"].includes(req.query.status) ? req.query.status : (req.query.status === "all" ? null : "pending");
  const where = [];
  const params = [];
  if (status) { where.push("r.status = ?"); params.push(status); }
  if (t.q) { where.push("(e.first_name LIKE ? OR e.last_name LIKE ? OR e.employee_no LIKE ? OR r.request_no LIKE ?)"); const l = likeTerm(t.q); params.push(l, l, l, l); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(await scalar(`SELECT COUNT(*) FROM bank_enrollment_requests r JOIN employees e ON e.id = r.employee_id ${W}`, params));
  const rows = await select(
    `SELECT r.id, r.request_no, r.request_type, r.bank_name, r.account_last4, r.account_type, r.status, r.submitted_at, r.decided_at, r.attachment_id,
            e.id AS employee_id, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department
       FROM bank_enrollment_requests r JOIN employees e ON e.id = r.employee_id JOIN departments d ON d.id = e.department_id
       ${W} ORDER BY ${t.orderBy}, r.id LIMIT ${t.limit} OFFSET ${t.offset}`, params);
  return { rows: rows.map((r) => ({ ...r, name: fullName(r) })), t, status: status || "all", meta: tableMeta(req, t, total, { status: status || "all" }) };
}

export async function getRequest(id) {
  const r = await selectOne(
    `SELECT r.*, e.employee_no, e.first_name, e.middle_name, e.last_name, e.suffix, d.name AS department, p.title AS position,
            sub.full_name AS submitted_by_name, decider.full_name AS decided_by_name,
            doc.original_name AS attachment_name, doc.mime_type AS attachment_mime
       FROM bank_enrollment_requests r
       JOIN employees e ON e.id = r.employee_id JOIN departments d ON d.id = e.department_id JOIN positions p ON p.id = e.position_id
       JOIN users sub ON sub.id = r.submitted_by LEFT JOIN users decider ON decider.id = r.decided_by
       LEFT JOIN document_attachments doc ON doc.id = r.attachment_id AND doc.deleted_at IS NULL
      WHERE r.id = ?`, [id]);
  if (!r) throw notFound("Bank enrollment request not found.");
  r.name = fullName(r);
  r.masked = maskNumber("0".repeat(8) + r.account_last4);
  r.nameMatches = holderMatches(r.account_holder_name, r);
  r.current = await selectOne("SELECT bank_name, account_last4, account_type, approved_at FROM bank_accounts WHERE employee_id = ? AND active_flag = 1", [r.employee_id]);
  r.approvals = await select(
    "SELECT a.action, a.remarks, a.decided_at, a.actor_role, u.full_name FROM bank_enrollment_approvals a JOIN users u ON u.id = a.actor_id WHERE a.request_id = ? ORDER BY a.id", [id]);
  return r;
}

// Separation of duties: nobody decides on their own request (a supervisor is also an employee).
async function assertCanDecide(req, r) {
  if (r.submitted_by === req.user.id || r.employee_id === req.user.employee_id) {
    throw forbidden("You cannot approve or reject your own bank enrollment. Another reviewer (Accounting or Payroll Staff, or the Accounting Supervisor) must review it.");
  }
}

export async function decide(req, id, action, remarks) {
  if (!["approved", "rejected"].includes(action)) throw badRequest("Invalid decision.");
  if (action === "rejected" && !remarks) throw badRequest("A reason is required when rejecting a request.");
  return tx(async (trx) => {
    const r = await selectOne("SELECT * FROM bank_enrollment_requests WHERE id = ? FOR UPDATE", [id], trx);
    if (!r) throw notFound("Bank enrollment request not found.");
    if (r.status !== "pending") throw badRequest(`This request was already ${r.status}.`);
    await assertCanDecide(req, r);

    let accountId = null;
    if (action === "approved") {
      await exec("SELECT id FROM employees WHERE id = ? FOR UPDATE", [r.employee_id], trx);
      await exec(
        "UPDATE bank_accounts SET status = 'superseded', active_flag = NULL, superseded_at = NOW() WHERE employee_id = ? AND active_flag = 1",
        [r.employee_id], trx);
      ({ insertId: accountId } = await exec(
        `INSERT INTO bank_accounts (employee_id, bank_name, account_holder_name, account_number_enc, account_last4, account_type,
           status, active_flag, approved_by, approved_at) VALUES (?,?,?,?,?,?,'active',1,?,NOW())`,
        [r.employee_id, r.bank_name, r.account_holder_name, r.account_number_enc, r.account_last4, r.account_type, req.user.id], trx));
    }
    await exec(
      "UPDATE bank_enrollment_requests SET status = ?, decided_by = ?, decided_at = NOW(), decision_remarks = ?, resulting_account_id = ? WHERE id = ?",
      [action, req.user.id, remarks || null, accountId, id], trx);
    await exec("INSERT INTO bank_enrollment_approvals (request_id, action, actor_id, actor_role, remarks) VALUES (?,?,?,?,?)",
      [id, action, req.user.id, req.user.role_code, remarks || null], trx);
    await audit(req, {
      action: `bank_enrollment_${action}`, module: "bank", recordType: "bank_enrollment_request", recordId: id, decision: action, remarks,
      next: { request_no: r.request_no, bank: r.bank_name, account: `••••${r.account_last4}`, resulting_account_id: accountId },
    }, trx);
    await notifyEmployee(r.employee_id, {
      type: `bank_enrollment_${action}`,
      title: action === "approved" ? "Bank account approved" : "Bank enrollment rejected",
      message: action === "approved"
        ? `${r.bank_name} account ending ${r.account_last4} is now your payroll account.`
        : `Your request ${r.request_no} was rejected: ${remarks}`,
      relatedType: "bank_enrollment_request", relatedId: id, link: "/my/bank",
    }, trx);
    return r;
  });
}

// Full number for verification against the supporting document. Audited every time; never written to logs.
export async function revealNumber(req, id) {
  const r = await selectOne("SELECT id, employee_id, submitted_by, account_number_enc, request_no, status FROM bank_enrollment_requests WHERE id = ?", [id]);
  if (!r) throw notFound("Bank enrollment request not found.");
  await assertCanDecide(req, r);
  // revealing is only justified while verifying a pending request — not a way to read historical account numbers
  if (r.status !== "pending") throw forbidden("Account numbers can only be revealed while a request is pending verification.");
  await audit(req, { action: "bank_number_revealed", module: "bank", recordType: "bank_enrollment_request", recordId: id, remarks: `Full account number viewed for verification of ${r.request_no}` });
  return decrypt(r.account_number_enc);
}
