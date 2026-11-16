> **Answered by CRM on 2026-11-16:** prices include 12% VAT; `payment_status` is always "paid" (no on_account, no
> part-paid). JVzPay follows that answer. This message is kept for the record.

To: JOHNVIVZ CRM team
From: Accounting/Payroll (JVzPay)
Subject: Please confirm two points of SaleCompleted before the connection test

Hello CRM team,

JVzPay now reads your SaleCompleted, SaleCancelled and RefundRecorded events in the shape of your contract v0.4.1,
and Accounting computes VAT as the contract decided. Before the connection test we need you to confirm two points.

1. Prices include 12% VAT.
   We take unit_price, line_total and totals as VAT-inclusive (Philippine shelf prices). For each sale, Output VAT is
   the amount of the items with is_vatable = true, after discounts, multiplied by 12/112. An order-level discount is
   spread over the items in proportion to their amounts first.
   Example: 2 × ₱56.00 vatable + 1.5 kg × ₱120.00 non-vatable with a ₱10.00 discount → net ₱282.00, Output VAT ₱12.00.
   Is that right, or are your prices VAT-exclusive?

2. payment_status is "paid" or "on_account".
   "paid": payments cover totals.net, and we post it as cash.
   "on_account": no payment yet, and we post a receivable for the whole net amount.
   For now we refuse a sale that is part paid and part on account. Are these the only values you send? If you also
   send others (for example "partial"), please tell us what they mean.

You can check how a sale was posted with GET /api/integration/v1/crm/sales/{sale_id}. The answer includes status,
tax_amount and the journal entry number.

Thank you,
Accounting/Payroll team
