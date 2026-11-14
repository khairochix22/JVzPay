// CRM Sales page (GET /accounting/sales): completed sales received from CRM and how each was posted, cancelled or refunded.
import { wrap } from "../../lib/errors.js";
import { select, selectOne } from "../../lib/db.js";

export const page = wrap(async (req, res) => {
  const [rows, totals] = await Promise.all([
    select(`SELECT s.*, j.entry_no FROM sales_imports s JOIN journal_entries j ON j.id = s.journal_entry_id ORDER BY s.transaction_date DESC, s.id DESC LIMIT 200`),
    selectOne(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_amount - refunded_amount END), 0) AS net,
                      COALESCE(SUM(CASE WHEN status <> 'cancelled' AND payment_status = 'on_account' THEN total_amount END), 0) AS on_account
                 FROM sales_imports WHERE transaction_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`),
  ]);
  res.render("sales-imports", { title: "CRM Sales", rows, totals });
});
