// Account Requests page (GET /users/requests): accounting staff sign-ups waiting for, or past, a decision.
import { wrap } from "../../lib/errors.js";
import { listRequests } from "../../services/accountRequestService.js";
import { HR_CONNECTED } from "../../services/hrDirectoryService.js";

export const queue = wrap(async (req, res) => {
  res.render("account-requests", { title: "Account Requests", hrConnected: HR_CONNECTED, ...(await listRequests(req)) });
});
