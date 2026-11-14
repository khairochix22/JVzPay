// A changed password must stay changed. Run in two phases with a server restart between them.
import { Client, check, report, db, errText } from "./lib.mjs";

const [base, phase] = process.argv.slice(2);
const email = "paolo@johnvivz.local", oldPassword = "Welcome2026ok", newPassword = "Rotated2026ok";

if (phase === "before") {
  const c = new Client(base);
  await c.login(email, oldPassword);
  let r = await c.get("/account/password");
  check("the change-password page names the account", r.text.includes(`Account: <strong>${email}</strong>`));
  const token = await c.csrf("/account/password");
  r = await c.post("/account/password", { _csrf: token, current_password: oldPassword, new_password: newPassword, confirm_password: newPassword });
  check("password change accepted", r.status === 302, errText(r));
  r = await c.get("/dashboard");
  check("the confirmation names the account", r.text.includes(`Password updated for ${email}`));
} else {
  let r = await new Client(base).login(email, oldPassword);
  check("after a restart the old password is refused", r.status === 401, String(r.status));
  r = await new Client(base).login(email, newPassword);
  check("after a restart the new password works", r.status === 302 && r.loc.startsWith("/dashboard"), `${r.status} ${r.loc}`);
}
report();
await db.sequelize.close();
process.exit(0);
