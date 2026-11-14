// My Overtime page (GET /my/overtime, POST /my/overtime/applications, POST cancel): employees apply for overtime with
// the date, start and end time and the reason, follow their supervisor's decision, and see the approved hours payroll pays.
import { wrap, HttpError } from "../../lib/errors.js";
import { myOvertime, checkApplication, applyOvertime, cancelApplication } from "../../services/overtimeService.js";

async function render(req, res, extra = {}, status = 200) {
  res.status(status).render("my-overtime", { title: "My Overtime", ...(await myOvertime(req.user.employee_id)), form: {}, errors: {}, ...extra });
}

export const page = wrap((req, res) => render(req, res));

export const apply = wrap(async (req, res) => {
  const { values, errors } = checkApplication(req.body);
  if (Object.keys(errors).length) return render(req, res, { form: values, errors }, 422);
  try {
    const r = await applyOvertime(req, values);
    req.flash("success_msg", `${r.no} (${r.hours} h) was sent to ${r.routed === "department" ? "your department supervisor through HR" : "the Accounting Supervisor"}.`);
    res.redirect("/my/overtime");
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return render(req, res, { form: values, errors: { form: e.message } }, e.status);
    throw e;
  }
});

export const cancel = wrap(async (req, res) => {
  await cancelApplication(req, Number(req.params.id));
  req.flash("success_msg", "Overtime application cancelled.");
  res.redirect("/my/overtime");
});
