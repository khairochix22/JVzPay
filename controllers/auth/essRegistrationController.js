// Employee account registration (GET/POST /register/employee, GET /register/employee/done).
// Open to people who are not signed in. Details are matched against HR; the account is active as soon as they match,
// and works only for the employee's own department (JVzPay for Payroll/Accounting, the department's app otherwise).
import { register } from "../../services/essRegistrationService.js";
import { lookups } from "../../services/employeeService.js";
import { accountingDepartment } from "../../lib/orgSettings.js";

const render = async (res, extra = {}, status = 200) =>
  res.status(status).render("register-employee", { title: "Create your employee account", ...(await lookups()), form: {}, errors: {}, ...extra });

export const page = async (req, res, next) => { try { await render(res); } catch (e) { next(e); } };

export const submit = async (req, res, next) => {
  try {
    const r = await register(req, req.body);
    if (r.errors) return render(res, { form: r.values, errors: r.errors }, 422);
    req.session.essRegistered = { department: r.department, departmentCode: r.departmentCode, position: r.position, roleName: r.roleName };
    res.redirect("/register/employee/done");
  } catch (e) {
    if (e.status === 400) return render(res, { form: req.body, errors: { form: e.message } }, 400);
    next(e);
  }
};

export const donePage = (req, res) => {
  const done = req.session.essRegistered;
  if (!done) return res.redirect("/register/employee");
  delete req.session.essRegistered;
  res.render("register-employee-done", { title: "Account activated", done, here: done.departmentCode === accountingDepartment() });
};
