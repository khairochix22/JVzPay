// System administration. URL map only; one controller per page in controllers/settings.
import express from "express";
import { requirePermission as can } from "../middleware/auth.js";
import * as settings from "../controllers/settings/systemSettingsController.js";
import * as roles from "../controllers/settings/rolesPermissionsController.js";
import * as announcements from "../controllers/settings/announcementsController.js";
import * as backup from "../controllers/settings/backupController.js";
import * as security from "../controllers/settings/securityMonitorController.js";
import * as signIns from "../controllers/settings/signInHistoryController.js";
import * as integration from "../controllers/integration/integrationController.js";

const r = express.Router();

r.get("/", can("settings.manage"), settings.page);
r.post("/", can("settings.manage"), settings.save);
r.get("/roles", can("roles.manage"), roles.page);
r.post("/roles", can("roles.manage"), roles.save);
r.get("/announcements", can("settings.manage"), announcements.page);
r.post("/announcements", can("settings.manage"), announcements.publish);
r.post("/announcements/:id(\\d+)/withdraw", can("settings.manage"), announcements.withdraw);
r.get("/security", can("audit.view"), security.page);
r.get("/security/sign-ins", can("audit.view"), signIns.page);
r.post("/security/verify-audit", can("audit.view"), security.verifyAudit);
r.get("/integration", can("integration.manage"), integration.page);
r.post("/integration/tokens", can("integration.manage"), integration.createToken);
r.post("/integration/tokens/:id(\\d+)/revoke", can("integration.manage"), integration.revokeToken);
r.post("/integration/inbox/:id(\\d+)/retry", can("integration.manage"), integration.retryIn);
r.post("/integration/outbox/:id(\\d+)/retry", can("integration.manage"), integration.retryOut);
r.get("/backup", can("settings.manage"), backup.page);
r.post("/backup", can("settings.manage"), backup.create);
r.post("/backup/cleanup", can("settings.manage"), backup.cleanup);
r.get("/backup/:name/download", can("settings.manage"), backup.download);
r.post("/backup/:name/delete", can("settings.manage"), backup.remove);

export default r;
