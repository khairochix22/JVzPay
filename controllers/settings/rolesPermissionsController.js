// Roles & Permissions page (GET/POST /settings/roles): the grant matrix (roles.manage).
import { wrap, action } from "../../lib/errors.js";
import { permissionMatrix, savePermissions } from "../../services/adminService.js";

export const page = wrap(async (req, res) => {
  res.render("roles-permissions", { title: "Roles & Permissions", ...(await permissionMatrix()) });
});

export const save = action(async (req) => {
  const { added, removed } = await savePermissions(req, req.body);
  return added || removed ? `Permissions updated: ${added} granted, ${removed} removed.` : "No changes to save.";
}, "/settings/roles");
