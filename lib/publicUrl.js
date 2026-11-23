// Full links that are handed to people (password reset, employee registration). On the server they start with
// PUBLIC_BASE_URL (https://johnvivz-pay.duckdns.org), never with the Host header a request happened to carry: behind
// Nginx that header is whatever the caller sent. On a laptop (PUBLIC_BASE_URL empty) the address the browser used.
import { env } from "../config/env.js";

export function publicBase(req) {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  return req ? `${req.protocol}://${req.get("host")}` : "";
}

/** publicUrl(req, "/register/employee") → "https://johnvivz-pay.duckdns.org/register/employee" */
export const publicUrl = (req, path) => `${publicBase(req)}${path.startsWith("/") ? path : `/${path}`}`;
