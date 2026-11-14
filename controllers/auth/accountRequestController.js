// Accounting Staff sign-up page (GET/POST /register, GET /register/sent): open to people who are not signed in.
import { submitRequest } from "../../services/accountRequestService.js";
import { HR_CONNECTED } from "../../services/hrDirectoryService.js";
import { lookups } from "../../services/employeeService.js";

const render = (res, extra = {}, status = 200) =>
  res.status(status).render("register", {
    title: "Request an accounting staff account",
    layoutBare: true,
    hrConnected: HR_CONNECTED,
    departments: [],
    positions: [],
    form: {},
    errors: {},
    ...extra,
  });

export const page = async (req, res, next) => {
  try {
    const directory = await lookups();
    render(res, directory);
  } catch (e) {
    next(e);
  }
};

export const sentPage = (req, res) => render(res, { sent: true });

export const submit = async (req, res, next) => {
  try {
    const result = await submitRequest(req, req.body);
    if (result.errors) {
      const directory = await lookups();
      return render(res, { ...directory, form: { ...result.values, department_id: req.body.department_id }, errors: result.errors }, 422);
    }
    res.redirect("/register/sent");
  } catch (e) {
    next(e);
  }
};
