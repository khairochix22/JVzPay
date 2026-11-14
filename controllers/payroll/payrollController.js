// Payroll page (GET /payroll): every payroll period with its payroll run — kinsenas (1–15, paid on the 25th) and katapusan
// (16–end, paid on the 10th), plus special weekly or monthly periods. Payroll Staff monitor and compute; the Accounting
// Supervisor adds periods (POST /payroll/periods/month, POST /payroll/periods/special) and approves, finalizes and releases
// each run from its page. Runs are computed automatically once the cutoff has passed (POST /payroll/periods/:id/compute
// recomputes on demand).
import { wrap, action, HttpError } from "../../lib/errors.js";
import { overview, ensureUpcoming, createFixedMonth, checkSpecial, createSpecial, computePeriod } from "../../services/payrollScheduleService.js";
import { select } from "../../lib/db.js";
import { fullName } from "../../services/employeeService.js";

async function render(req, res, extra = {}, status = 200) {
  await ensureUpcoming();
  const filter = ["semi_monthly", "special"].includes(req.query.show) ? req.query.show : "";
  const canPeriods = req.user.can("payroll.periods");
  const [periods, departments, others] = await Promise.all([
    overview(filter),
    canPeriods ? select("SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name") : [],
    canPeriods ? select("SELECT id, employee_no, first_name, middle_name, last_name, suffix, pay_frequency FROM employees WHERE deleted_at IS NULL AND employment_status IN ('active','on_leave') AND pay_frequency <> 'semi_monthly' ORDER BY last_name, first_name") : [],
  ]);
  const now = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  res.status(status).render("payroll", {
    title: "Payroll", periods, filter, departments, otherEmployees: others.map((e) => ({ ...e, name: fullName(e) })),
    canPeriods, canPrepare: req.user.can("payroll.prepare"), month: now.slice(0, 7), special: {}, errors: {}, ...extra,
  });
}

export const page = wrap((req, res) => render(req, res));

export const addMonth = action(async (req) => {
  const made = await createFixedMonth(req, String(req.body.month || ""));
  return made.length ? `Created ${made.join(" and ")} on the fixed dates.` : "Both periods of that month already exist.";
}, "/payroll");

export const addSpecial = wrap(async (req, res) => {
  const { values, errors } = checkSpecial(req.body);
  if (Object.keys(errors).length) return render(req, res, { special: values, errors }, 422);
  try {
    const r = await createSpecial(req, values);
    req.flash("success_msg", `${r.code} was created; pay is released on ${r.release}.`);
    res.redirect("/payroll?show=special");
  } catch (e) {
    if (e instanceof HttpError && e.status < 500 && e.status !== 403) return render(req, res, { special: values, errors: { form: e.message } }, e.status);
    throw e;
  }
});

export const compute = wrap(async (req, res) => {
  try {
    const r = await computePeriod(req, Number(req.params.id));
    req.flash("success_msg", `${r.no} ${r.created ? "computed" : "recomputed"} for ${r.count} employee(s).`);
    res.redirect(`/payroll/batches/${r.id}`);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500 || e.status === 403) throw e;
    req.flash("error_msg", e.message);
    res.redirect("/payroll");
  }
});
