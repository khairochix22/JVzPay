// Privacy notice acknowledgement (GET/POST /privacy/acknowledge): everyone reads the current notice once before using JVzPay,
// and again whenever the Accounting Supervisor changes the notice version in System Settings.
import { wrap } from "../../lib/errors.js";
import { exec } from "../../lib/db.js";
import { audit } from "../../lib/audit.js";
import { getSetting } from "../../lib/settings.js";

async function render(req, res, extra = {}, status = 200) {
  const [person, email, phone, retention] = await Promise.all(
    ["privacy.accountable_person", "privacy.contact_email", "privacy.contact_phone", "privacy.retention"].map((k) => getSetting(k, "")));
  res.status(status).render("privacy-acknowledge", { title: "Privacy Notice", privacy: { person, email, phone, retention }, ...extra });
}

export const page = wrap((req, res) => render(req, res));

export const submit = wrap(async (req, res) => {
  if (req.body.agree !== "1") return render(req, res, { error: "Tick the box to confirm you have read the Privacy Notice." }, 422);
  const version = String(await getSetting("privacy.notice_version", "1"));
  await exec("UPDATE users SET privacy_ack_version = ?, privacy_ack_at = NOW() WHERE id = ?", [version, req.user.id]);
  await audit(req, { action: "privacy_notice_acknowledged", module: "auth", recordType: "user", recordId: req.user.id, remarks: `Privacy Notice version ${version}` });
  const back = typeof req.session.returnTo === "string" && req.session.returnTo.startsWith("/") && !req.session.returnTo.startsWith("/privacy") ? req.session.returnTo : "/dashboard";
  delete req.session.returnTo;
  res.redirect(back);
});
