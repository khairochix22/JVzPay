// POST /api/v1/events — HR, CRM and Inventory send their events here with a service token (docs/API_INTEGRATION.md).
// No session and no CSRF: the bearer token is the credential, and each token is bound to one source application.
import { authenticateClient, receiveEvent } from "../../services/integrationService.js";
import { jsonApi } from "../../middleware/apiClient.js";
import { inboundEventStatus, outboundFeed } from "../../services/integrationQueryService.js";

export const receive = async (req, res) => {
  try {
    const client = await authenticateClient(req.get("authorization"));
    if (!client) return res.status(401).json({ status: "unauthorized", error: "Missing, wrong or revoked service token." });
    const result = await receiveEvent(client, req.body);
    res.status(result.httpStatus).json({ status: result.status, ...(result.error ? { error: result.error } : {}) });
  } catch (e) {
    if (e.status === 400 || e.statusCode === 400) return res.status(400).json({ status: "invalid", error: e.message });
    console.error("[api] /events failed:", e);
    res.status(500).json({ status: "error", error: "The event could not be stored. Retry later with the same event_id." });
  }
};

// GET /api/v1/health — lets the other teams check the address and their token without sending an event
export const health = async (req, res) => {
  const client = await authenticateClient(req.get("authorization"));
  if (!client) return res.status(401).json({ status: "unauthorized" });
  res.json({ status: "ok", application: "johnvivz_accounting", source: client.source, time: new Date().toISOString() });
};

// POST /api/v1/auth/login — a department application (CRM, Inventory, HR) checks an employee's email and password.
// Only employees of that application's department are accepted; everyone else is refused (owner's rule, 2026-11-13).
export const departmentLogin = async (req, res) => {
  try {
    const client = await authenticateClient(req.get("authorization"));
    if (!client) return res.status(401).json({ authenticated: false, error: "Missing, wrong or revoked service token." });
    const { departmentSignIn } = await import("../../services/essRegistrationService.js");
    const r = await departmentSignIn(req, client, req.body || {});
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error("[api] /auth/login failed:", e);
    res.status(500).json({ authenticated: false, error: "Sign-in could not be checked. Try again." });
  }
};

// GET /api/v1/events/:eventId — status of an event your application sent (processed, failed + error, …)
// GET /api/v1/feed?after=<sequence> — events JVzPay has for your application, for polling instead of (or besides) push
export const eventStatus = jsonApi((req) => inboundEventStatus(req.apiClient, req.params.eventId));
export const feed = jsonApi((req) => outboundFeed(req.apiClient, req.query));
