// Accounting. URL map only; one controller per page in controllers/accounting.
import express from "express";
import { requirePermission as can, requireAny as any } from "../middleware/auth.js";
import { optionalUpload } from "../middleware/upload.js";
import * as accounts from "../controllers/accounting/chartOfAccountsController.js";
import * as categories from "../controllers/accounting/transactionCategoriesController.js";
import * as income from "../controllers/accounting/incomeController.js";
import * as expense from "../controllers/accounting/expenseController.js";
import * as approvals from "../controllers/accounting/accountingApprovalsController.js";
import * as adjustments from "../controllers/accounting/accountingAdjustmentsController.js";
import * as journalList from "../controllers/accounting/journalListController.js";
import * as journalEntry from "../controllers/accounting/journalEntryController.js";
import * as periods from "../controllers/accounting/financialPeriodsController.js";
import * as payables from "../controllers/accounting/payablesController.js";
import * as receivables from "../controllers/accounting/receivablesController.js";
import * as banks from "../controllers/accounting/bankReconciliationController.js";
import * as reconciliation from "../controllers/accounting/reconciliationController.js";
import * as budgets from "../controllers/accounting/budgetsController.js";
import * as sales from "../controllers/accounting/salesImportsController.js";

const r = express.Router();
const ID = ":id(\\d+)";
const viewers = any("accounting.view", "accounting.prepare");
const recorders = any("accounting.manage", "accounting.prepare");

r.get("/accounts", can("accounting.view"), accounts.page);
r.post("/accounts", can("accounting.manage"), accounts.save);
r.post(`/accounts/${ID}`, can("accounting.manage"), accounts.save);
r.post(`/accounts/${ID}/toggle`, can("accounting.manage"), accounts.toggle);

r.get("/categories", can("accounting.view"), categories.page);
r.post("/categories", can("accounting.manage"), categories.add);
r.post(`/categories/${ID}/toggle`, can("accounting.manage"), categories.toggle);

r.get("/income", viewers, income.page);
r.post("/income", recorders, optionalUpload("attachment"), income.create);
r.post(`/income/${ID}/void`, can("accounting.manage"), income.voidTxn);
r.get("/expenses", viewers, expense.page);
r.post("/expenses", recorders, optionalUpload("attachment"), expense.create);
r.post(`/expenses/${ID}/void`, can("accounting.manage"), expense.voidTxn);

r.get("/adjustments", recorders, adjustments.page);
r.post("/adjustments", recorders, adjustments.create);
r.get("/approvals", can("accounting.adjust.approve"), approvals.queue);
r.post(`/approvals/${ID}/decision`, can("accounting.adjust.approve"), approvals.decision);

r.get("/journals", can("accounting.view"), journalList.list);
r.get(`/journals/${ID}`, can("accounting.view"), journalEntry.show);
r.get("/periods", can("accounting.view"), periods.page);
r.post(`/periods/${ID}/close`, can("accounting.manage"), periods.close);
r.post(`/periods/${ID}/reopen`, can("accounting.manage"), periods.reopen);

// accounts payable, receivable, banks, budgets and CRM sales (master prompt §IX–§XI)
r.get("/payables", any("payables.prepare", "payables.approve"), payables.page);
r.post("/payables/suppliers", can("payables.prepare"), payables.addSupplier);
r.post("/payables/invoices", can("payables.prepare"), optionalUpload("attachment"), payables.createInvoice);
r.post(`/payables/invoices/${ID}/decision`, can("payables.approve"), payables.decide);
r.post(`/payables/invoices/${ID}/payments`, can("payables.prepare"), payables.pay);
r.post(`/payables/invoices/${ID}/void`, can("payables.approve"), payables.voidInvoice);
r.get("/receivables", can("receivables.manage"), receivables.page);
r.post("/receivables", can("receivables.manage"), receivables.create);
r.post("/receivables/customers", can("receivables.manage"), receivables.addCustomer);
r.post(`/receivables/${ID}/collections`, can("receivables.manage"), receivables.collect);
r.post(`/receivables/${ID}/void`, can("receivables.manage"), receivables.voidReceivable);
r.get("/banks", can("bank.reconcile"), banks.page);
r.post("/banks", can("bank.reconcile"), banks.addBank);
r.post(`/banks/${ID}/reconciliations`, can("bank.reconcile"), banks.start);
r.get(`/reconciliations/${ID}`, can("bank.reconcile"), reconciliation.show);
r.post(`/reconciliations/${ID}`, can("bank.reconcile"), reconciliation.save);
r.get("/budgets", can("accounting.view"), budgets.page);
r.post("/budgets", can("budgets.manage"), budgets.save);
r.get("/sales", can("accounting.view"), sales.page);

export default r;
