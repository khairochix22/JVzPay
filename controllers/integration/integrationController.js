// Integration page (GET /settings/integration): connection status, service tokens, events received and sent, retries.
import { wrap } from "../../lib/errors.js";
import { integrationOverview, createClient, revokeClient, retryInbox, retryOutbox, SOURCES, targetConfig } from "../../services/integrationService.js";
import { syncFromHr, lastSync } from "../../services/hrSyncService.js";
import { pollInventory, lastPoll } from "../../services/inventoryPollService.js";

const DIRECTIONS = ["in", "out"];
const STATUSES = { in: ["processed", "failed", "received"], out: ["sent", "pending", "not_connected", "failed"] };

export const page = wrap(async (req, res) => {
  const direction = DIRECTIONS.includes(req.query.direction) ? req.query.direction : "in";
  const status = STATUSES[direction].includes(req.query.status) ? req.query.status : "";
  const [data, hrSync, invPoll] = await Promise.all([integrationOverview({ direction, status }), lastSync(), lastPoll()]);
  res.render("integration", {
    title: "Integration", ...data, direction, status, statuses: STATUSES[direction],
    hrSync, invPoll, hrConnected: targetConfig("hr").connected, invConnected: targetConfig("inventory").connected,
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

// POST /settings/integration/hr-sync: "Sync now" (HR is pull-only; the scheduler also runs it every 15 minutes)
export const syncHr = wrap(async (req, res) => {
  const s = await syncFromHr({ req, trigger: "manual" });
  if (s.ok) req.flash("success_msg", `HR sync done: ${s.employees.seen} employees (${s.employees.created} new, ${s.employees.status_changed + s.employees.separated} status changes), ${s.compensation.recorded} new salary versions${s.problems.length ? `, ${s.problems.length} problem(s) listed below` : ""}.`);
  else req.flash("error_msg", `HR sync failed: ${s.error}`);
  res.redirect("/settings/integration");
});

// POST /settings/integration/inventory-poll: "Poll now" (the scheduler also polls every minute)
export const pollInv = wrap(async (req, res) => {
  const s = await pollInventory({ trigger: "manual" });
  if (s.ok) req.flash("success_msg", `Inventory poll done: ${s.received} read, ${s.stored} stored, ${s.acknowledged} acknowledged.`);
  else req.flash("error_msg", `Inventory poll failed: ${s.error}`);
  res.redirect("/settings/integration");
});

export const retryOut = wrap(async (req, res) => {
  await retryOutbox(req, Number(req.params.id));
  req.flash("success_msg", "Delivery attempted. See the status below.");
  res.redirect("/settings/integration?direction=out");
});
