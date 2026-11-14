// Sign-in history page (GET /settings/security/sign-ins): every sign-in, sign-out, failed attempt, lockout and password event.
import { wrap } from "../../lib/errors.js";
import { signInHistory } from "../../services/securityService.js";

export const page = wrap(async (req, res) => {
  res.render("sign-in-history", { title: "Sign-in History", ...(await signInHistory(req)) });
});
