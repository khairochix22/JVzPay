// Integration page (GET /settings/integration): connection status, service tokens, events received and sent, retries.
import { wrap } from "../../lib/errors.js";
import { integrationOverview, createClient, revokeClient, retryInbox, retryOutbox, SOURCES } from "../../services/integrationService.js";

const DIRECTIONS = ["in", "out"];
const STATUSES = { in: ["processed", "failed", "received"], out: ["sent", "pending", "not_connected", "failed"] };

export const page = wrap(async (req, res) => {
  const direction = DIRECTIONS.includes(req.query.direction) ? req.query.direction : "in";
  const status = STATUSES[direction].includes(req.query.status) ? req.query.status : "";
  const data = await integrationOverview({ direction, status });
  res.render("integration", {
    title: "Integration", ...data, direction, status, statuses: STATUSES[direction],
    sources: Object.entries(SOURCES).map(([code, label]) => ({ code, label })),
    newToken: req.flash("integration_token")[0] || null,
  });
});

export const createToken = wrap(async (req, res) => {
  const { token } = await createClient(req, { source: req.body.source, name: req.body.name });
  req.flash("integration_token", token);
  req.flash("success_msg", "Token created. Copy it now: it is shown only once.");
  res.redirect("/settings/integration");
});

export const revokeToken = wrap(async (req, res) => {
  await revokeClient(req, Number(req.params.id));
  req.flash("success_msg", "Token revoked. Calls using it are refused from now on.");
  res.redirect("/settings/integration");
});

export const retryIn = wrap(async (req, res) => {
  const r = await retryInbox(req, Number(req.params.id));
  req.flash(r.status === "processed" ? "success_msg" : "error_msg", r.status === "processed" ? "The event was applied." : `Still failing: ${r.error}`);
  res.redirect("/settings/integration?direction=in");
});

export const retryOut = wrap(async (req, res) => {
  await retryOutbox(req, Number(req.params.id));
  req.flash("success_msg", "Delivery attempted. See the status below.");
  res.redirect("/settings/integration?direction=out");
});
