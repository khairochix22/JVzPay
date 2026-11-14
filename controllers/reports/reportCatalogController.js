// Reports page (GET /reports): every report this user is allowed to generate, grouped by area.
import { wrap } from "../../lib/errors.js";
import { REPORTS } from "../../services/reportDefinitions.js";

export const catalog = wrap(async (req, res) => {
  const groups = new Map();
  for (const def of Object.values(REPORTS)) {
    if (!req.user.canAny(...def.perms)) continue;
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(def);
  }
  res.render("reports", { title: "Reports", groups: [...groups].map(([name, items]) => ({ name, items })) });
});
