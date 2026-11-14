// Account Request review page (GET /users/requests/:id, POST /users/requests/:id/decision).
import { wrap, HttpError } from "../../lib/errors.js";
import { getRequest, decideRequest } from "../../services/accountRequestService.js";
import { HR_CONNECTED } from "../../services/hrDirectoryService.js";

async function render(req, res, extra = {}, status = 200) {
  const r = await getRequest(Number(req.params.id));
  res.status(status).render("account-request", { title: r.full_name, r, hrConnected: HR_CONNECTED, remarks: "", ...extra });
}

export const reviewPage = wrap((req, res) => render(req, res));

export const decision = wrap(async (req, res) => {
  try {
    const r = await decideRequest(req, Number(req.params.id), req.body.action, req.body.remarks);
    req.flash("success_msg", r.status === "approved"
      ? `Accounting Staff account created for ${r.email}. They sign in with the password they chose.`
      : `The request from ${r.full_name} was rejected.`);
    res.redirect(r.status === "approved" ? `/users/requests/${r.id}` : "/users/requests");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500 || e.status === 403) throw e;
    await render(req, res, { error: e.message, remarks: req.body.remarks }, e.status);
  }
});
