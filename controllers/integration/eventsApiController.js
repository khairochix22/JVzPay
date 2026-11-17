// POST /api/v1/events (also /api/integration/v1/events) — HR, CRM and Inventory send their events here.
// No session and no CSRF. The caller proves who it is with signed X-JVZ-* headers (CRM integration contract §2) or a
// bearer service token (docs/API_INTEGRATION.md §1); either way the credential is bound to one source application.
//
// Answers to a SIGNED caller follow the contract (§4, §5): 202 {"status":"accepted"} once the event is stored, whatever its
// processing gave (the result is in GET /events/{event_id} and on JVzPay's Integration page), 200 {"status":"duplicate"},
// 400 {"error":"invalid_json"|"invalid_envelope","details":[…]}, 401 {"error":"<code>"}.
// Answers to a BEARER caller are unchanged: 202 processed, 200 duplicate, 400 invalid, 422 failed.
import crypto from "node:crypto";
import { authenticateRequest, receiveEvent } from "../../services/integrationService.js";
import { jsonApi } from "../../middleware/apiClient.js";
import { inboundEventStatus, outboundFeed } from "../../services/integrationQueryService.js";

/** 401 body: the contract's code for a signed caller, JVzPay's usual message for a bearer caller. */
export const authErrorBody = (auth) =>
  auth.signed ? { error: auth.error } : { status: "unauthorized", error: "Missing, wrong or revoked service token." };

export const receive = async (req, res) => {
  let auth;
  try {
    auth = await authenticateRequest(req);
    if (auth.error) return res.status(401).json(authErrorBody(auth));
    const eventId = req.body?.event_id ?? null;
    const result = await receiveEvent(auth.client, req.body);
    if (auth.signed) {
      if (result.status === "duplicate") return res.status(200).json({ status: "duplicate", event_id: eventId });
      return res.status(202).json({ status: "accepted", event_id: eventId, processing: result.status, ...(result.error ? { error: result.error } : {}) });
    }
    res.status(result.httpStatus).json({ status: result.status, ...(result.error ? { error: result.error } : {}) });
  } catch (e) {
    if (e.status === 400 || e.statusCode === 400) {
      return auth?.signed
        ? res.status(400).json({ error: "invalid_envelope", details: [e.message] })
        : res.status(400).json({ status: "invalid", error: e.message });
    }
    console.error("[api] /events failed:", e);
    res.status(500).json({ status: "error", error: "The event could not be stored. Retry later with the same event_id." });
  }
};

// GET /api/v1/health — lets the other teams check the address and their credentials without sending an event
export const health = async (req, res) => {
  const auth = await authenticateRequest(req);
  if (auth.error) return res.status(401).json(authErrorBody(auth));
  res.json({ status: "ok", app: "johnvivz_accounting", application: "johnvivz_accounting", source: auth.client.source, as_of: new Date().toISOString(), time: new Date().toISOString() });
};

// POST /api/integration/v1/test/echo — connection test for a signed request WITH a body (CRM's check-connections):
// answers 200 with what was received, so the caller knows the body was signed and read exactly as sent. Stores nothing.
export const echo = async (req, res) => {
  const auth = await authenticateRequest(req);
  if (auth.error) return res.status(401).json(authErrorBody(auth));
  const raw = req.rawBody || Buffer.from("");
  res.json({
    status: "ok", app: "johnvivz_accounting", source: auth.client.source, signed: auth.signed,
    method: req.method, path: req.originalUrl, received_at: new Date().toISOString(),
    body_sha256: crypto.createHash("sha256").update(raw).digest("hex"), echo: req.body ?? null,
  });
};

// POST /api/integration/v1/auth/login — CRM (signed) or Inventory (bearer token) checks an employee's email and ESS
// password. 200 {employee_id, employee_code, full_name, email, department_code, department_name, position,
// employment_status, ess_registered_at}; 401 {"error":"invalid_credentials"}; 403 {"error":"not_allowed"}.
// A missing or wrong service credential is 401 too, with the credential's own code (see authErrorBody).
export const departmentLogin = async (req, res) => {
  try {
    const auth = await authenticateRequest(req);
    if (auth.error) return res.status(401).json(authErrorBody(auth));
    const { departmentSignIn } = await import("../../services/essRegistrationService.js");
    const r = await departmentSignIn(req, auth.client, req.body || {});
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error("[api] /auth/login failed:", e);
    res.status(500).json({ error: "unavailable" });
  }
};

// GET /api/v1/events/:eventId — status of an event your application sent (processed, failed + error, …)
// GET /api/v1/feed?after=<sequence> — events JVzPay has for your application, for polling instead of (or besides) push
export const eventStatus = jsonApi((req) => inboundEventStatus(req.apiClient, req.params.eventId));
export const feed = jsonApi((req) => outboundFeed(req.apiClient, req.query));
