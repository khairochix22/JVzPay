// Expenses page (GET/POST /accounting/expenses): operating expenses with receipts. Payroll expense is booked by payroll batches, never here.
import { transactionPage } from "../../lib/transactionPage.js";

export const { page, create, voidTxn } = transactionPage({ type: "expense", title: "Expenses", path: "/accounting/expenses" });
