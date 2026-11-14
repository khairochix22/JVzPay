// Privacy Notice page (GET /privacy): open to everyone, including people who have not signed in yet.
import { wrap } from "../../lib/errors.js";
import { getSetting } from "../../lib/settings.js";

export const page = wrap(async (req, res) => {
  const [person, email, phone, retention] = await Promise.all(
    ["privacy.accountable_person", "privacy.contact_email", "privacy.contact_phone", "privacy.retention"].map((k) => getSetting(k, "")));
  res.render("privacy", { title: "Privacy Notice", layoutBare: !req.user, privacy: { person, email, phone, retention } });
});
