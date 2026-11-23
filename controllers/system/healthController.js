// Health checks for monitoring. Both are public and reveal no data.
//   GET /health   the app process answers (no database call): for an uptime monitor, PM2 or a load balancer.
//   GET /healthz  also asks the database "SELECT 1": tells "app up, MySQL down" apart from "all fine".
// The signed /api/integration/v1/health (controllers/integration/eventsApiController.js) is for the other JOHNVIVZ apps.
import { scalar } from "../../lib/db.js";

export const alive = (req, res) => {
  res.set("Cache-Control", "no-store").json({ status: "ok" });
};

export const health = async (req, res) => {
  const started = Date.now();
  try {
    await scalar("SELECT 1");
    res.json({ status: "ok", database: "ok", responseMs: Date.now() - started });
  } catch {
    res.status(503).json({ status: "error", database: "unreachable" });
  }
};
