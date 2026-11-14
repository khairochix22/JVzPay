// Chart of Accounts page (GET/POST /accounting/accounts).
import { wrap, action, badRequest } from "../../lib/errors.js";
import { validate } from "../../lib/validate.js";
import { listAccounts, saveAccount, toggleAccount, ACCOUNT_TYPES } from "../../services/accountingService.js";

const schema = {
  code: { label: "Code", required: true, max: 20, pattern: /^[0-9A-Za-z-]+$/, patternMessage: "Code may contain letters, digits and dashes." },
  name: { label: "Name", required: true, max: 120 },
  account_type: { label: "Type", type: "enum", values: ACCOUNT_TYPES, required: true },
  parent_id: { label: "Parent account", type: "id" },
  is_cash: { type: "bool" },
  description: { label: "Description", max: 255 },
};

export const page = wrap(async (req, res) => {
  res.render("chart-of-accounts", { title: "Chart of Accounts", accounts: await listAccounts(), types: ACCOUNT_TYPES, canManage: req.user.can("accounting.manage") });
});

export const save = action(async (req) => {
  const { values, errors, ok } = validate(req.body, schema);
  if (!ok) throw badRequest(Object.values(errors).join(" "));
  const a = await saveAccount(req, req.params.id ? Number(req.params.id) : null, values);
  return `Account ${a.code} saved.`;
}, "/accounting/accounts");

export const toggle = action(async (req) => {
  const a = await toggleAccount(req, Number(req.params.id));
  return `Account ${a.code} is now ${a.is_active ? "active" : "inactive"}.`;
}, "/accounting/accounts");
