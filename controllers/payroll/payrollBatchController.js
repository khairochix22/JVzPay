// Payroll batch page (GET /payroll/batches/:id) and its workflow actions. Each action needs its own permission (see routes/payroll.js).
import { wrap, action } from "../../lib/errors.js";
import * as svc from "../../services/payrollService.js";

const back = (req) => `/payroll/batches/${req.params.id}`;
const id = (req) => Number(req.params.id);
const text = (req, k) => String(req.body[k] || "").trim().slice(0, 500);

export const show = wrap(async (req, res) => {
  const b = await svc.getBatch(id(req));
  const own = await svc.approverOwnRecord(req, b.id);
  const preparedByMe = b.prepared_by === req.user.id || b.submitted_by === req.user.id;
  res.render("payroll-batch", {
    title: `Payroll ${b.batch_no}`, b, ownRecord: own, preparedByMe,
    can: {
      prepare: b.status === "draft" && req.user.can("payroll.prepare"),
      review: b.status === "for_review" && req.user.can("payroll.approve") && !preparedByMe,
      finalize: b.status === "approved" && req.user.can("payroll.finalize"),
      release: b.status === "finalized" && req.user.can("payroll.finalize"),
      void: ["approved", "finalized", "released"].includes(b.status) && req.user.can("payroll.finalize"),
    },
  });
});

export const recompute = action(async (req) => `Recomputed for ${await svc.recomputeBatch(req, id(req))} employee(s).`, back);
export const submit = action(async (req) => { const b = await svc.submitBatch(req, id(req)); return `${b.batch_no} was submitted to the Accounting Supervisor.`; }, back);
export const approve = action(async (req) => { const b = await svc.approveBatch(req, id(req), { remarks: text(req, "remarks"), acknowledgeOwn: req.body.acknowledge_own === "1" }); return `${b.batch_no} was approved. Finalize it to lock the figures.`; }, back);
export const reject = action(async (req) => { const b = await svc.rejectBatch(req, id(req), text(req, "reason")); return `${b.batch_no} was returned to Payroll Staff.`; }, back);
export const finalize = action(async (req) => { const b = await svc.finalizeBatch(req, id(req)); return `${b.batch_no} was finalized: attendance locked, payslips generated, accrual posted.`; }, back);
export const release = action(async (req) => { const b = await svc.releaseBatch(req, id(req)); return `${b.batch_no} was released. Employees can now see their payslips.`; }, back);
export const voidBatch = action(async (req) => { const b = await svc.voidBatch(req, id(req), text(req, "reason")); return `${b.batch_no} was voided and its journals were reversed.`; }, back);
