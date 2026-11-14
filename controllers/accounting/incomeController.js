// Income page (GET/POST /accounting/income): business income records with supporting documents.
import { transactionPage } from "../../lib/transactionPage.js";

export const { page, create, voidTxn } = transactionPage({ type: "income", title: "Income", path: "/accounting/income" });
