// Security Monitor page (GET /settings/security): failed sign-ins, locked accounts, active sessions, sensitive actions,
// system health, and the audit-trail seal check (POST /settings/security/verify-audit). Needs audit.view.
import { wrap, action, HttpError } from "../../lib/errors.js";
import { securityOverview } from "../../services/adminService.js";
import { systemHealth, verifyAuditNow } from "../../services/securityService.js";

export const page = wrap(async (req, res) => {
  const [overview, health] = await Promise.all([securityOverview(), systemHealth()]);
  res.render("security-monitor", { title: "Security Monitor", ...overview, health });
});

export const verifyAudit = action(async (req) => {
  const r = await verifyAuditNow(req);
  if (!r.ok) throw new HttpError(409, `Audit trail check FAILED: ${r.problem}`);
  return `Audit trail verified: ${r.checked} sealed record(s) are intact.`;
}, "/settings/security");
