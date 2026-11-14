// Password reset page (GET/POST /reset-password/:token): a one-time, expiring link created by an Accounting Supervisor.
import { wrap } from "../../lib/errors.js";
import { findValidReset, completeReset } from "../../services/passwordResetService.js";

const render = (res, extra, status = 200) =>
  res.status(status).render("reset-password", { title: "Choose a new password", layoutBare: true, errors: {}, ...extra });

export const page = wrap(async (req, res) => {
  const reset = await findValidReset(req.params.token);
  render(res, reset ? { token: req.params.token, email: reset.email, expiresAt: reset.expires_at } : { invalid: true }, reset ? 200 : 410);
});

export const submit = wrap(async (req, res) => {
  const result = await completeReset(req, req.params.token, req.body.new_password, req.body.confirm_password);
  if (result.invalid) return render(res, { invalid: true }, 410);
  if (result.errors) return render(res, { token: req.params.token, email: result.reset.email, expiresAt: result.reset.expires_at, errors: result.errors }, 422);
  req.flash("success_msg", `Password set for ${result.email}. Sign in with your new password.`);
  res.redirect("/login");
});
