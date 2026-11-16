// Service guard for the read API (/api/v1/hr/*, /crm/*, /inventory/*, /feed, /events/:id).
// The signed X-JVZ-* headers or the bearer token identify the calling application; `only` limits a route group to it.
import { authenticateRequest } from "../services/integrationService.js";
import { HttpError } from "../lib/errors.js";

export const requireClient = (...only) => async (req, res, next) => {
  try {
    const auth = await authenticateRequest(req);
    if (auth.error) return res.status(401).json(auth.signed ? { error: auth.error } : { status: "unauthorized", error: "Missing, wrong or revoked service token." });
    const client = auth.client;
    if (only.length && !only.includes(client.source)) {
      return res.status(403).json({ status: "forbidden", error: `This endpoint is for ${only.join(", ")}; you are ${client.source}.` });
    }
    req.apiClient = client;
    next();
  } catch (e) { next(e); }
};

/** Wrap a JSON handler: HttpErrors become { status, error } with their code; anything else is a logged 500. */
export const jsonApi = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) {
      const status = e.status === 404 ? "not_found" : e.status === 403 ? "forbidden" : "invalid";
      return res.status(e.status).json({ status, error: e.message });
    }
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, e);
    res.status(500).json({ status: "error", error: "The request could not be completed. Try again later." });
  }
};
