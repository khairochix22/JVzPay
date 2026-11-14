/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// My Bank Account page (GET /my/bank): current masked account, enrollment/update request, history.
import { wrap, HttpError } from "../../lib/errors.js";
import { getEmployee } from "../../services/employeeService.js";
import * as bank from "../../services/bankService.js";

const isUserError = (e) => e instanceof HttpError && e.status < 500;

async function bankPage(req, res, extra = {}, status = 200) {
  const e = await getEmployee(req.user.employee_id);
  const data = await bank.myBank(req.user.employee_id);
  res.status(status).render("my-bank", {
    title: "My Bank Account", e, ...data, banks: bank.BANKS, types: bank.ACCOUNT_TYPES,
    form: { account_holder_name: e.name }, errors: {}, ...extra,
  });
}

export const showBank = wrap((req, res) => bankPage(req, res, { showForm: req.query.new === "1" }));

export const submitBankRequest = wrap(async (req, res) => {
  const e = await getEmployee(req.user.employee_id);
  const { values, errors } = bank.validateBankInput(req.body, e, !!req.file);
  if (req.uploadError) errors.attachment = req.uploadError;
  // never echo the account number back into the page
  const safeForm = { ...values, account_number: "", account_number_confirm: "" };
  if (Object.keys(errors).length) return bankPage(req, res, { form: safeForm, errors, showForm: true, cleared: true }, 422);
  try {
    const { requestNo } = await bank.submitRequest(req, values, req.file);
    req.flash("success_msg", `Bank enrollment ${requestNo} was submitted. Your payroll account changes only after an Accounting Supervisor approves it.`);
    res.redirect("/my/bank");
  } catch (err) {
    if (!isUserError(err)) throw err;
    return bankPage(req, res, { form: safeForm, errors: { form: err.message }, showForm: true, cleared: true }, err.status);
  }
});

export const cancelBankRequest = wrap(async (req, res) => {
  await bank.cancelRequest(req, Number(req.params.id));
  req.flash("success_msg", "Bank enrollment request cancelled.");
  res.redirect("/my/bank");
});
