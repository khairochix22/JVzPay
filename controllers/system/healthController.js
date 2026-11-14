// GET /healthz: for an uptime monitor. Public, and reveals nothing beyond "up" and whether the database answers.
import { scalar } from "../../lib/db.js";

export const health = async (req, res) => {
  const started = Date.now();
  try {
    await scalar("SELECT 1");
    res.json({ status: "ok", database: "ok", responseMs: Date.now() - started });
  } catch {
    res.status(503).json({ status: "error", database: "unreachable" });
  }
};
