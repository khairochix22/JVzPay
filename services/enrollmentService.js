// Self-Service enrollments (master prompt §V): government numbers, dependents and benefits.
// Employees submit for themselves; Payroll Staff (or the Accounting Supervisor) verify. Nobody decides their own request.
// Government numbers are encrypted at rest and only ever shown masked; approved numbers update the payroll record.
import { select, selectOne, scalar, exec, tx } from "../lib/db.js";
import { audit } from "../lib/audit.js";
import { encrypt, maskEncrypted } from "../lib/crypto.js";
import { nextDocNo } from "../lib/sequence.js";
import { notifyEmployee, notifyPermission } from "../lib/notify.js";
import { saveAttachment } from "../middleware/upload.js";
import { badRequest, notFound, forbidden } from "../lib/errors.js";
import { getSetting } from "../lib/settings.js";
import { enqueue } from "./integrationService.js";

// ---- government numbers --------------------------------------------------------------------------------------------------
// formats used by the agencies; digits are what is stored
export const GOV = [
  { key: "sss", col: "sss_no_enc", label: "SSS number", digits: 10, hint: "10 digits, e.g. 00-0000000-0" },
  { key: "philhealth", col: "philhealth_no_enc", label: "PhilHealth number (PIN)", digits: 12, hint: "12 digits, e.g. 00-000000000-0" },
  { key: "pagibig", col: "pagibig_no_enc", label: "Pag-IBIG MID number", digits: 12, hint: "12 digits, e.g. 0000-0000-0000" },
  { key: "tin", col: "tin_enc", label: "BIR TIN", digits: [9, 12], hint: "9 or 12 digits, e.g. 000-000-000-000" },
];

export function checkGovernment(body) {
  const values = {}, errors = {};
  for (const g of GOV) {
    const raw = String(body[g.key] || "").trim();
    if (!raw) continue;
    const d = raw.replace(/[\s-]/g, "");
    const lengths = Array.isArray(g.digits) ? g.digits : [g.digits];
    if (!/^\d+$/.test(d) || !lengths.includes(d.length)) errors[g.key] = `${g.label}: ${g.hint}.`;
    else values[g.key] = d;
  }
  if (!Object.keys(values).length && !Object.keys(errors).length) errors.form = "Enter at least one number to enroll or update.";
  return { values, errors };
}

export async function myGovernment(employeeId) {
  const [emp, requests] = await Promise.all([
    selectOne("SELECT sss_no_enc, philhealth_no_enc, pagibig_no_enc, tin_enc FROM employees WHERE id = ?", [employeeId]),
    select("SELECT * FROM statutory_enrollments WHERE employee_id = ? ORDER BY id DESC LIMIT 20", [employeeId]),
  ]);
  return {
    onFile: GOV.map((g) => ({ ...g, masked: emp?.[g.col] ? maskEncrypted(emp[g.col]) : null })),
    requests: requests.map((r) => ({ ...r, fields: GOV.filter((g) => r[g.col]).map((g) => `${g.label.split(" ")[0]} ${maskEncrypted(r[g.col])}`).join(" · ") })),
    pending: requests.some((r) => r.status === "pending"),
  };
}

export async function submitGovernment(req, values, file) {
  const employeeId = req.user.employee_id;
  return tx(async (trx) => {
    await selectOne("SELECT id FROM employees WHERE id = ? FOR UPDATE", [employeeId], trx);
    if (await scalar("SELECT COUNT(*) FROM statutory_enrollments WHERE employee_id = ? AND status = 'pending'", [employeeId], trx))
      throw badRequest("You already have a pending government enrollment. Wait for it to be verified, or cancel it.");
    const no = await nextDocNo("GOV", 4, trx);
    const { insertId } = await exec(
      "INSERT INTO statutory_enrollments (request_no, employee_id, sss_no_enc, philhealth_no_enc, pagibig_no_enc, tin_enc, submitted_by) VALUES (?,?,?,?,?,?,?)",
      [no, employeeId, ...GOV.map((g) => (values[g.key] ? encrypt(values[g.key]) : null)), req.user.id], trx);
    const doc = await saveAttachment(req, file, "statutory_enrollment", insertId, trx);
    if (doc) await exec("UPDATE statutory_enrollments SET attachment_id = ? WHERE id = ?", [doc, insertId], trx);
    await audit(req, { action: "statutory_enrollment_submitted", module: "self", recordType: "statutory_enrollment", recordId: insertId, next: { request_no: no, numbers: GOV.filter((g) => values[g.key]).map((g) => g.key) } }, trx);
    await notifyPermission("statutory.review", { type: "statutory_submitted", title: "Government enrollment to verify", message: `${req.user.full_name} submitted ${no}.`, relatedType: "statutory_enrollment", relatedId: insertId, link: "/payroll/enrollments" }, { excludeUserId: req.user.id }, trx);
    return no;
  });
}

// ---- dependents and benefits ---------------------------------------------------------------------------------------------
export const RELATIONSHIPS = ["spouse", "child", "parent", "sibling", "other"];
// The company's two fixed benefits (owner, 2026-11-13); providers and limits come from System Settings (benefits.*).
export const BENEFIT_TYPES = [{ key: "hmo", label: "HMO" }, { key: "life_accident", label: "Life and accident insurance" }];
export const IMMEDIATE_FAMILY = ["spouse", "child", "parent"]; // who the HMO may cover
export const BENEFICIARY_RELATIONS = ["spouse", "child", "parent", "sibling"]; // spouse or a family member

export async function benefitPlans() {
  return {
    hmo: { provider: String(await getSetting("benefits.hmo_provider", "Cocolife")), coverage: Number(await getSetting("benefits.hmo_coverage", 250000)), maxDependents: Number(await getSetting("benefits.hmo_max_dependents", 3)) },
    insurance: { provider: String(await getSetting("benefits.insurance_provider", "Insulife — Pru Life UK")), maxBeneficiaries: Number(await getSetting("benefits.insurance_max_beneficiaries", 2)) },
  };
}

export function checkDependent(body) {
  const v = { full_name: String(body.full_name || "").trim().replace(/\s+/g, " "), relationship: String(body.relationship || ""), birth_date: String(body.birth_date || ""), remarks: String(body.remarks || "").trim().slice(0, 255) || null };
  const errors = {};
  if (!v.full_name || v.full_name.length > 160) errors.full_name = "Enter the dependent's full name.";
  if (!RELATIONSHIPS.includes(v.relationship)) errors.relationship = "Choose the relationship.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.birth_date) || new Date(v.birth_date) > new Date()) errors.birth_date = "Enter a valid birth date.";
  return { values: v, errors };
}

/** Checks an enrollment form. HMO: the verified dependents to cover (dependent_ids). Insurance: beneficiaries in the named
 *  fields ben_1_name, ben_1_relationship, ben_1_birth_date, ben_2_… (named fields, so a blank first row cannot shift the second). */
export function checkBenefit(body, plans) {
  const v = { benefit_type: String(body.benefit_type || ""), remarks: String(body.remarks || "").trim().slice(0, 255) || null, dependent_ids: [], beneficiaries: [] };
  const errors = {};
  if (!BENEFIT_TYPES.some((b) => b.key === v.benefit_type)) errors.benefit_type = "Choose the benefit.";
  if (v.benefit_type === "hmo") {
    const raw = body.dependent_ids === undefined ? [] : [].concat(body.dependent_ids);
    v.dependent_ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (v.dependent_ids.length > plans.hmo.maxDependents) errors.dependent_ids = `The HMO covers up to ${plans.hmo.maxDependents} dependents.`;
  }
  if (v.benefit_type === "life_accident") {
    for (let i = 1; i <= plans.insurance.maxBeneficiaries; i++) {
      const b = { full_name: String(body[`ben_${i}_name`] || "").trim().replace(/\s+/g, " "), relationship: String(body[`ben_${i}_relationship`] || ""), birth_date: String(body[`ben_${i}_birth_date`] || "") || null };
      if (!b.full_name && !b.relationship && !b.birth_date) continue;
      if (!b.full_name || b.full_name.length > 160) errors[`ben_${i}_name`] = "Enter the beneficiary's full name.";
      if (!BENEFICIARY_RELATIONS.includes(b.relationship)) errors[`ben_${i}_relationship`] = "A beneficiary must be your spouse or a family member.";
      if (b.birth_date && (!/^\d{4}-\d{2}-\d{2}$/.test(b.birth_date) || new Date(b.birth_date) > new Date())) errors[`ben_${i}_birth_date`] = "Enter a valid birth date.";
      v.beneficiaries.push(b);
    }
    if (!v.beneficiaries.length) errors.ben_1_name = "Name at least one beneficiary.";
    const share = v.beneficiaries.length ? Math.round((100 / v.beneficiaries.length) * 100) / 100 : 0;
    v.beneficiaries = v.beneficiaries.map((b) => ({ ...b, share_percent: share }));
  }
  return { values: v, errors };
}

/** Eligibility comes from the employment type HR assigned and the types listed in System Settings. */
export async function benefitEligibility(employeeId) {
  const emp = await selectOne("SELECT employment_type, employment_status FROM employees WHERE id = ?", [employeeId]);
  const types = String(await getSetting("benefits.eligible_types", "regular")).split(",").map((s) => s.trim()).filter(Boolean);
  const typeOk = !!emp && types.includes(emp.employment_type);
  const statusOk = !!emp && ["active", "on_leave"].includes(emp.employment_status);
  // say exactly why, so the employee knows what HR has to correct
  const reason = !emp ? "Your account is not linked to an HR employee record."
    : !statusOk ? `Your HR record says you are ${emp.employment_status.replace("_", " ")}; benefits are for active employees.`
      : !typeOk ? `Company benefits are for ${types.join(", ")} employees; your employment type is ${emp.employment_type.replace("_", " ")}.` : null;
  return { eligible: typeOk && statusOk, reason, employmentType: emp?.employment_type, employmentStatus: emp?.employment_status, eligibleTypes: types };
}

export async function myBenefits(employeeId) {
  const [dependents, benefits, eligibility, plans] = await Promise.all([
    select("SELECT * FROM dependent_enrollments WHERE employee_id = ? AND status <> 'cancelled' ORDER BY id DESC", [employeeId]),
    select("SELECT * FROM benefit_enrollment_references WHERE employee_id = ? ORDER BY id DESC", [employeeId]),
    benefitEligibility(employeeId),
    benefitPlans(),
  ]);
  await attachDetails(benefits);
  const has = (type) => benefits.some((b) => b.benefit_type === type && ["pending", "approved"].includes(b.status));
  return {
    dependents, benefits, eligibility, plans, approvedDependents: dependents.filter((d) => d.status === "approved").length,
    coverable: dependents.filter((d) => d.status === "approved" && IMMEDIATE_FAMILY.includes(d.relationship)),
    hasHmo: has("hmo"), hasInsurance: has("life_accident"),
  };
}

/** Adds the covered dependents and the beneficiaries to enrollment rows (for the employee and the reviewers). */
async function attachDetails(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const covered = await select(`SELECT c.enrollment_id, d.full_name, d.relationship FROM benefit_covered_dependents c JOIN dependent_enrollments d ON d.id = c.dependent_id WHERE c.enrollment_id IN (${marks})`, ids);
  const bens = await select(`SELECT * FROM benefit_beneficiaries WHERE enrollment_id IN (${marks}) ORDER BY id`, ids);
  for (const r of rows) {
    r.covered = covered.filter((c) => c.enrollment_id === r.id);
    r.beneficiaries = bens.filter((b) => b.enrollment_id === r.id);
  }
  return rows;
}

export async function submitDependent(req, v, file) {
  const employeeId = req.user.employee_id;
  return tx(async (trx) => {
    const no = await nextDocNo("DEP", 4, trx);
    const { insertId } = await exec("INSERT INTO dependent_enrollments (request_no, employee_id, full_name, relationship, birth_date, remarks, submitted_by) VALUES (?,?,?,?,?,?,?)",
      [no, employeeId, v.full_name, v.relationship, v.birth_date, v.remarks, req.user.id], trx);
    const doc = await saveAttachment(req, file, "dependent_enrollment", insertId, trx);
    if (doc) await exec("UPDATE dependent_enrollments SET attachment_id = ? WHERE id = ?", [doc, insertId], trx);
    await audit(req, { action: "dependent_submitted", module: "self", recordType: "dependent_enrollment", recordId: insertId, next: { request_no: no, relationship: v.relationship } }, trx);
    await notifyPermission("benefits.review", { type: "dependent_submitted", title: "Dependent to verify", message: `${req.user.full_name} added a dependent (${no}).`, relatedType: "dependent_enrollment", relatedId: insertId, link: "/payroll/enrollments" }, { excludeUserId: req.user.id }, trx);
    return no;
  });
}

export async function submitBenefit(req, v, file) {
  const employeeId = req.user.employee_id;
  const elig = await benefitEligibility(employeeId);
  if (!elig.eligible) throw badRequest(elig.reason);
  const plans = await benefitPlans();
  return tx(async (trx) => {
    if (await scalar("SELECT COUNT(*) FROM benefit_enrollment_references WHERE employee_id = ? AND benefit_type = ? AND status IN ('pending','approved')", [employeeId, v.benefit_type], trx))
      throw badRequest("You already have this benefit, or a request for it is waiting.");
    let plan, coverage = null;
    if (v.benefit_type === "hmo") {
      plan = `${plans.hmo.provider} HMO`; coverage = plans.hmo.coverage;
      for (const id of v.dependent_ids) {
        const d = await selectOne("SELECT full_name, relationship, status FROM dependent_enrollments WHERE id = ? AND employee_id = ?", [id, employeeId], trx);
        if (!d || d.status !== "approved") throw badRequest("Only your verified dependents can be covered.");
        if (!IMMEDIATE_FAMILY.includes(d.relationship)) throw badRequest(`${d.full_name} is not immediate family (spouse, child or parent), so the HMO cannot cover them.`);
      }
    } else {
      plan = `${plans.insurance.provider} life and accident insurance`;
    }
    const no = await nextDocNo("BEN", 4, trx);
    const { insertId } = await exec("INSERT INTO benefit_enrollment_references (request_no, employee_id, benefit_type, plan_name, coverage_amount, dependents_count, remarks, submitted_by) VALUES (?,?,?,?,?,?,?,?)",
      [no, employeeId, v.benefit_type, plan.slice(0, 120), coverage, v.dependent_ids.length, v.remarks, req.user.id], trx);
    for (const id of v.dependent_ids) await exec("INSERT INTO benefit_covered_dependents (enrollment_id, dependent_id) VALUES (?,?)", [insertId, id], trx);
    for (const b of v.beneficiaries) await exec("INSERT INTO benefit_beneficiaries (enrollment_id, full_name, relationship, birth_date, share_percent) VALUES (?,?,?,?,?)", [insertId, b.full_name, b.relationship, b.birth_date, b.share_percent], trx);
    v.plan_name = plan;
    const doc = await saveAttachment(req, file, "benefit_enrollment", insertId, trx);
    if (doc) await exec("UPDATE benefit_enrollment_references SET attachment_id = ? WHERE id = ?", [doc, insertId], trx);
    await audit(req, { action: "benefit_enrollment_submitted", module: "self", recordType: "benefit_enrollment", recordId: insertId, next: { request_no: no, benefit: v.benefit_type, plan: v.plan_name } }, trx);
    await notifyPermission("benefits.review", { type: "benefit_submitted", title: "Benefit enrollment to verify", message: `${req.user.full_name} asked to enroll in ${v.plan_name} (${no}).`, relatedType: "benefit_enrollment", relatedId: insertId, link: "/payroll/enrollments" }, { excludeUserId: req.user.id }, trx);
    return no;
  });
}

const TABLES = {
  statutory: { table: "statutory_enrollments", perm: "statutory.review", label: "Government enrollment" },
  dependent: { table: "dependent_enrollments", perm: "benefits.review", label: "Dependent" },
  benefit: { table: "benefit_enrollment_references", perm: "benefits.review", label: "Benefit enrollment" },
};

export async function cancelOwn(req, kind, id) {
  const t = TABLES[kind];
  if (!t) throw notFound("Request not found.");
  const r = await selectOne(`SELECT * FROM ${t.table} WHERE id = ?`, [id]);
  if (!r || r.employee_id !== req.user.employee_id) throw notFound("Request not found.");
  if (r.status !== "pending") throw badRequest("Only pending requests can be cancelled.");
  await exec(`UPDATE ${t.table} SET status = 'cancelled' WHERE id = ?`, [id]);
  await audit(req, { action: `${kind}_enrollment_cancelled`, module: "self", recordType: t.table, recordId: id });
}

// ---- verification queue (Payroll Staff) -----------------------------------------------------------------------------------
export async function reviewQueue(user) {
  const out = {};
  const who = "e.employee_no, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, d.name AS department";
  const join = "JOIN employees e ON e.id = x.employee_id JOIN departments d ON d.id = e.department_id";
  if (user.can("statutory.review")) {
    const rows = await select(`SELECT x.*, ${who} FROM statutory_enrollments x ${join} ORDER BY x.status = 'pending' DESC, x.id DESC LIMIT 50`);
    out.statutory = rows.map((r) => ({ ...r, fields: GOV.filter((g) => r[g.col]).map((g) => `${g.label.split(" ")[0]} ${maskEncrypted(r[g.col])}`).join(" · "), own: r.employee_id === user.employee_id }));
  }
  if (user.can("benefits.review")) {
    out.dependents = (await select(`SELECT x.*, ${who} FROM dependent_enrollments x ${join} ORDER BY x.status = 'pending' DESC, x.id DESC LIMIT 50`)).map((r) => ({ ...r, own: r.employee_id === user.employee_id }));
    out.benefits = (await attachDetails(await select(`SELECT x.*, ${who} FROM benefit_enrollment_references x ${join} ORDER BY x.status = 'pending' DESC, x.id DESC LIMIT 50`))).map((r) => ({ ...r, own: r.employee_id === user.employee_id }));
  }
  return out;
}

export async function decide(req, kind, id, action, remarks) {
  const t = TABLES[kind];
  if (!t) throw notFound("Request not found.");
  if (!req.user.can(t.perm)) throw forbidden();
  if (!["approve", "reject"].includes(action)) throw badRequest("Choose approve or reject.");
  const why = String(remarks || "").trim().slice(0, 500);
  if (action === "reject" && !why) throw badRequest("Give a reason for rejecting it.");
  await tx(async (trx) => {
    const r = await selectOne(`SELECT * FROM ${t.table} WHERE id = ? FOR UPDATE`, [id], trx);
    if (!r) throw notFound("Request not found.");
    if (r.status !== "pending") throw badRequest("This request has already been decided.");
    if (r.employee_id === req.user.employee_id || r.submitted_by === req.user.id) throw forbidden("You cannot verify your own request. Another Payroll Staff member or the Accounting Supervisor must.");
    const status = action === "approve" ? "approved" : "rejected";
    await exec(`UPDATE ${t.table} SET status = ?, decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?`, [status, req.user.id, why || null, id], trx);
    const emp = await selectOne("SELECT hr_employee_id, employee_no FROM employees WHERE id = ?", [r.employee_id], trx);
    if (status === "approved" && kind === "statutory") {
      const sets = GOV.filter((g) => r[g.col]);
      // the verified numbers replace the ones payroll uses
      await exec(`UPDATE employees SET ${sets.map((g) => `${g.col} = ?`).join(", ")} WHERE id = ?`, [...sets.map((g) => r[g.col]), r.employee_id], trx);
    }
    if (status === "approved" && kind !== "statutory") {
      await enqueue("hr", kind === "dependent" ? "DependentEnrolled" : "BenefitEnrolled", emp?.hr_employee_id,
        kind === "dependent" ? { employee_id: emp?.hr_employee_id, request_no: r.request_no, full_name: r.full_name, relationship: r.relationship, birth_date: String(r.birth_date).slice(0, 10) }
          : { employee_id: emp?.hr_employee_id, request_no: r.request_no, benefit_type: r.benefit_type, plan_name: r.plan_name, coverage_amount: r.coverage_amount, dependents_count: r.dependents_count,
              covered_dependents: await select("SELECT d.request_no, d.full_name, d.relationship FROM benefit_covered_dependents c JOIN dependent_enrollments d ON d.id = c.dependent_id WHERE c.enrollment_id = ?", [id], trx),
              beneficiaries: (await select("SELECT full_name, relationship, birth_date, share_percent FROM benefit_beneficiaries WHERE enrollment_id = ?", [id], trx)).map((b) => ({ ...b, birth_date: b.birth_date ? String(b.birth_date).slice(0, 10) : null })) }, trx);
    }
    await audit(req, { action: `${kind}_enrollment_${status}`, module: "self", recordType: t.table, recordId: id, decision: status, remarks: why || null }, trx);
    await notifyEmployee(r.employee_id, { type: `${kind}_decided`, title: `${t.label} ${status}`, message: `${r.request_no} was ${status}${why ? `: ${why}` : "."}`, relatedType: t.table, relatedId: id, link: kind === "statutory" ? "/my/government" : "/my/benefits" }, trx);
  });
}
