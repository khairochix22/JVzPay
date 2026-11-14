// My Dependents & Benefits page (GET /my/benefits; POST dependents, benefits, cancel): add dependents with proof,
// see benefit eligibility, enroll in company benefits, and follow each request's status.
import { wrap, HttpError } from "../../lib/errors.js";
import * as svc from "../../services/enrollmentService.js";

async function render(req, res, extra = {}, status = 200) {
  res.status(status).render("my-benefits", {
    title: "Dependents & Benefits", ...(await svc.myBenefits(req.user.employee_id)),
    relationships: svc.RELATIONSHIPS, beneficiaryRelations: svc.BENEFICIARY_RELATIONS, depForm: {}, benForm: {}, depErrors: {}, benErrors: {}, ...extra,
  });
}

export const page = wrap((req, res) => render(req, res));

const userError = (e) => e instanceof HttpError && e.status < 500;

export const addDependent = wrap(async (req, res) => {
  const { values, errors } = svc.checkDependent(req.body);
  if (req.uploadError) errors.attachment = req.uploadError;
  if (Object.keys(errors).length) return render(req, res, { depForm: values, depErrors: errors }, 422);
  try {
    const no = await svc.submitDependent(req, values, req.file);
    req.flash("success_msg", `${no} was submitted for verification.`);
    res.redirect("/my/benefits");
  } catch (e) { if (userError(e)) return render(req, res, { depForm: values, depErrors: { form: e.message } }, e.status); throw e; }
});

export const enroll = wrap(async (req, res) => {
  const { values, errors } = svc.checkBenefit(req.body, await svc.benefitPlans());
  if (req.uploadError) errors.attachment = req.uploadError;
  if (Object.keys(errors).length) return render(req, res, { benForm: { ...req.body, ...values }, benErrors: errors }, 422);
  try {
    const no = await svc.submitBenefit(req, values, req.file);
    req.flash("success_msg", `${no} was submitted for verification.`);
    res.redirect("/my/benefits");
  } catch (e) { if (userError(e)) return render(req, res, { benForm: { ...req.body, ...values }, benErrors: { form: e.message } }, e.status); throw e; }
});

export const cancel = wrap(async (req, res) => {
  await svc.cancelOwn(req, req.params.kind === "benefit" ? "benefit" : "dependent", Number(req.params.id));
  req.flash("success_msg", "Request cancelled.");
  res.redirect("/my/benefits");
});
