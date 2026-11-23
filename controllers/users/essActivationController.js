// Employee Registrations page (GET /users/registrations): every account created from an HR-matched registration,
// with the department and role it opens. Accounts activate on their own once HR's record matches.
import { wrap } from "../../lib/errors.js";
import { registrations } from "../../services/essRegistrationService.js";
import { publicUrl } from "../../lib/publicUrl.js";

export const page = wrap(async (req, res) => {
  res.render("ess-activations", { title: "Employee Registrations", rows: await registrations(), registrationUrl: publicUrl(req, "/register/employee") });
});
