# JVzPay integration API (version 1)

For the HR, CRM and Inventory developers. JVzPay is the JOHNVIVZ **Accounting & Payroll** application.
The four applications keep separate databases and never read each other's tables; they talk only through the
calls below. Field names and event types are a proposal from the Accounting team: confirm them together before
coding, and record any change here.

**Status (2026-11-13):** HR, CRM and Inventory are still being built. When they are integrated, the **HR system is the
host** of the JOHNVIVZ ecosystem. JVzPay's side is ready: the endpoints below work today, events for the other
applications wait in JVzPay's outbox (*not connected*) until their addresses are set, and nothing has to change in
JVzPay when the HR host routes or proxies these calls, as long as it forwards the `Authorization` header and body.

## 1. Authentication

Every call carries a service token in the `Authorization` header:

```
Authorization: Bearer <token>
Content-Type: application/json
```

* Each application gets its **own** token. The Accounting Supervisor creates it in JVzPay under
  *System → Integration*, where it is shown once. JVzPay stores only a SHA-256 hash of it.
* A token is tied to one source (`johnvivz_hr`, `johnvivz_crm` or `johnvivz_inventory`). An event whose `source`
  does not match the token is refused.
* Use HTTPS between servers in production. Tokens can be revoked and replaced at any time.

## 2. Sending events to JVzPay

`POST /api/v1/events`

```json
{
  "event_id": "9b2f0c64-3a51-4c3e-9b1e-0a2d1f7c55e1",
  "event_type": "EmployeeCreated",
  "schema_version": 1,
  "source": "johnvivz_hr",
  "occurred_at": "2026-11-13T09:15:00+08:00",
  "entity_id": "HR-000123",
  "correlation_id": "4c0d7a5e-0a0b-4a53-9c8f-6f41a1e0d3a2",
  "idempotency_key": "EmployeeCreated:HR-000123:1",
  "data": { }
}
```

| Response | Meaning |
|---|---|
| `202 {"status":"processed"}` | Accepted and applied. |
| `200 {"status":"duplicate"}` | The same `event_id` (or `idempotency_key`) was already received; nothing was applied twice. |
| `400` | The envelope or `data` is invalid. The reason is in `error`. Fix and send a new event. |
| `401` / `403` | Missing, wrong or revoked token, or a `source` that does not match the token. |
| `422 {"status":"failed"}` | Stored but could not be applied (for example an unknown employee). It stays in JVzPay's inbox, where the Accounting Supervisor can retry it after the cause is fixed. Do not resend it. |

Send events in the order they happened for the same `entity_id`. Retry a request only when no response arrived
or the response was `5xx`; the `event_id` makes retries safe.

### 2.1 Events from HR

HR is the only source of the employee master. JVzPay keeps a read-only snapshot of each employee for payroll.

| `event_type` | `data` |
|---|---|
| `EmployeeCreated`, `EmployeeUpdated` | `employee_id` (HR id), `employee_no`, `first_name`, `middle_name`, `last_name`, `suffix`, `birth_date`, `email`, `phone`, `department_code`, `department_name`, `position_title`, `employment_type` (`regular`, `probationary`, `contractual`, `part_time`), `employment_status` (`active`, `on_leave`, `suspended`, `resigned`, `terminated`), `date_hired`, `verification_reference` (the unique code HR generated; the new hire types it when registering), `effective_date`. `email` is the personal email the new hire must use to register. Optional `supervisor_employee_id`: the HR id of the immediate supervisor or team leader, who gives the first approval of the employee's requests. |
| `EmployeeStatusChanged` | `employee_id`, `employment_status`, `effective_date`, `separation_date` (when leaving) |
| `EmployeeCompensationApproved` | `employee_id`, `compensation_version_id`, `rate_basis` (`monthly` or `daily`), `basic_salary`, `pay_frequency` (`semi_monthly` or `monthly`), `allowances` (the complete approved list for this version, each `{ "code", "amount" }`; an empty list means no recurring HR allowance), `effective_date`, `approval_reference` |
| `DepartmentUpserted` | `department_code`, `department_name`, `is_active` |
| `PositionUpserted` | `department_code`, `position_title`, `is_active` |
| `RequestDecided` | `request_type` (`leave`, `attendance_correction`, `overtime`, `leave_conversion`), `request_no` (JVzPay's number), `decision` (`approved` or `rejected`), `approver_employee_id`, `approver_name`, `remarks` (required when rejecting), `decided_at`. This is the **first approval** — the immediate supervisor or team leader's (two-step approval, 2026-11-13). Accepted only for requests JVzPay sent to HR. An approval sends the request to Accounting/Payroll for the final decision; a rejection ends it with JVzPay's rules, and HR then receives the outcome (`LeaveRecorded`, `OvertimeRecorded`, …). |
| `ScheduleDaysPlotted` | `employee_id` (HR id), `days`: up to 62 of `{ "date": "YYYY-MM-DD", "shift_start", "am_break_start", "lunch_start", "lunch_end", "pm_break_start", "shift_end" }` (HH:MM, in that order; breaks are 15 minutes) or `{ "date", "day_off": true }`, or `{ "date", "clear": true }` to return a day to the company default; optional `remarks`. HR plots each employee's schedule day by day and may re-plot any day (days off included) except days already in finalized payroll. The employee's calendar, the time clock and payroll use the latest plot. |

Rules JVzPay applies:

* A new salary takes effect on its `effective_date`; a payroll period uses the version in force on its end date.
  Earlier versions are kept.
* HR is the source of truth for the employee's approved compensation package. Accounting/Payroll does not use
  position-band amounts as the employee's pay; it processes the HR-approved salary history and HR-approved allowance
  lines effective for the payroll period.
* HR-approved basic salary must be within the active monthly compensation band for the employee's active position.
  Daily-rate offers are converted to a monthly equivalent using 261 days per year before the range check. Offers
  outside the range are rejected and are not available to Accounting/Payroll.
* Each `EmployeeCompensationApproved` event replaces the employee's earlier HR allowance package from its effective
  date. Allowance lines omitted from the complete list are ended; an empty list intentionally removes recurring HR
  allowances.
* When an employee leaves, payroll stops after `separation_date`; past payroll records are never changed.
* Payroll for a period is blocked while any active employee's snapshot is older than the last HR change JVzPay
  knows about (see *Payroll readiness* in JVzPay).

### 2.2 Events from CRM

| `event_type` | `data` |
|---|---|
| `SaleCompleted` | `transaction_id`, `order_id`, `customer_ref`, `transaction_date`, `payment_status` (`paid` or `on_account`), `payment_method`, `lines` (list of `{ "product_ref", "quantity", "unit_price", "discount", "tax" }`), `total_amount` |
| `SaleCancelled`, `RefundRecorded` | `transaction_id` (of the original sale), `reason`, `amount`, `date` |

JVzPay posts each sale as a journal entry (Dr Cash or Accounts Receivable, Cr Sales Revenue, Cr tax payable when
`tax` is present). Cancellations and refunds are posted as reversals; nothing is deleted. `total_amount` must
equal the sum of the lines, or the event is refused.

### 2.3 Events from Inventory

| `event_type` | `data` |
|---|---|
| `PurchaseOrderApproved` | `purchase_order_id`, `supplier_ref`, `supplier_name`, `order_date`, `lines` (list of `{ "product_ref", "quantity", "unit_cost" }`), `total_amount` |
| `GoodsReceived` | `goods_receipt_id`, `purchase_order_id`, `received_date`, `lines` (list of `{ "product_ref", "quantity", "unit_cost" }`), `total_amount` |
| `SupplierInvoiceReceived` | `supplier_invoice_no`, `purchase_order_id`, `goods_receipt_id`, `invoice_date`, `due_date`, `amount` |
| `StockAdjusted` | `adjustment_id`, `date`, `amount` (positive = gain, negative = loss), `reason` |
| `InventoryValuationReported` | `as_of`, `total_value` |

A supplier invoice becomes an account payable only when its purchase order and goods receipt are on record and
the amounts agree (three-way match). Inventory owns stock quantities; JVzPay records only their money value.

## 3. Calls JVzPay makes to other applications

JVzPay sends its own events to each application's endpoint with the same envelope and that application's token.
The addresses and tokens go in JVzPay's `.env`: `HR_API_URL`, `HR_API_TOKEN`, `CRM_API_URL`, `CRM_API_TOKEN`,
`INVENTORY_API_URL`, `INVENTORY_API_TOKEN`. Until an address is set, JVzPay keeps the events in its outbox
marked *not connected* and sends them once it is.

| To | `event_type` | When |
|---|---|---|
| HR | `LeaveRequested`, `AttendanceCorrectionRequested`, `OvertimeRequested`, `LeaveConversionRequested` | An employee **outside Payroll/Accounting** files a request in Self-Service. HR finds the employee's department supervisor and returns `RequestDecided`. Payroll/Accounting employees' requests are decided in JVzPay by the Accounting Supervisor. |
| HR | `LeaveRecorded`, `AttendanceCorrected`, `OvertimeRecorded`, or `LeaveRejected`, `AttendanceCorrectionRejected`, `OvertimeRejected` | Every final decision, whoever made it. Accounting/Payroll keeps the official attendance, leave and overtime record (owner's decision, 2026-11-11); HR receives a copy. |
| HR | `EmployeeAccountActivated` | A new hire registered and the account is active. |
| HR | `DependentEnrolled`, `BenefitEnrolled` | Payroll Staff verified a dependent or a benefit enrollment. `BenefitEnrolled` carries `benefit_type` (`hmo` = Cocolife HMO, ₱250,000 coverage, up to 3 immediate-family dependents in `covered_dependents`; `life_accident` = combined life and accident insurance with up to 2 `beneficiaries` — name, relationship, birth date, share %), `plan_name`, `coverage_amount`. |
| HR, analytics | `PayrollApproved`, `PayslipPublished`, `PayrollPaymentRecorded` | Payroll moves through approval and release. |
| All | `JournalPosted` | A journal entry is posted. |

### 3.1 Employee accounts: HR → Payroll/Accounting → the employee's department

This is the owner's flow (2026-11-13), the same for every department:

1. **HR** encodes the new hire, including the personal email, assigns the department and position, and generates
   the **Employee ID** and a **unique code**. HR sends `EmployeeCreated` with `employee_no`, `email`,
   `department_code`, `position_title` and `verification_reference` (the unique code).
2. **Payroll/Accounting (JVzPay)**: the new hire opens `/register/employee` and enters the Employee ID, unique code,
   full name, email, department and position, and chooses a password. When every field matches HR's record (the email
   must be the one HR encoded) and the employee is active with no account yet, the account is **activated at once**.
   JVzPay then sends HR `EmployeeAccountActivated`.
3. **The employee's department application** signs the person in with that email and password by asking JVzPay:

`POST /api/v1/auth/login` (with the department application's own service token)

```json
{ "email": "andrea.bautista@gmail.com", "password": "…" }
```

| Response | Meaning |
|---|---|
| `200 {"authenticated":true,"user":{…}}` | Correct password and the employee belongs to **your** department. `user` has `email`, `full_name`, `employee_id` (HR id), `employee_no`, `department_code`, `department_name`, `position_title`, `employment_status`. Start your own session and use `position_title` for your role. |
| `401 {"authenticated":false}` | Unknown email or wrong password (the answer does not say which). |
| `403 {"authenticated":false}` | The password is right but the employee belongs to another department, or is no longer employed. |
| `423 {"authenticated":false}` | Locked for a while after too many wrong passwords. |

The token decides the department: a CRM token accepts only CRM employees, an Inventory token only Inventory
employees, an HR token only HR employees. Payroll/Accounting employees sign in to JVzPay itself, with the role of
their position (Accounting Supervisor, Accounting Staff or Payroll Staff). Every employee also keeps JVzPay
Self-Service (payslips, leave, attendance, bank and government enrollment) with the same email and password.
Passwords never leave JVzPay; do not store them in your application.

When HR's API is configured (`HR_API_URL`), JVzPay also asks it to confirm a registration:
`POST {HR_API_URL}/api/v1/employees/verify` with `employee_id`, `full_name`, `email`, `department`, `position`,
`verification_reference`, answering `{ "match": true, "eligible": true }` or `{ "match": false }`.

## 4. Monitoring

*System → Integration* in JVzPay shows every event received and sent, with its status (processed, duplicate,
failed, pending, not connected), the error, the number of attempts and the correlation id. Failed inbound events
can be retried there after the cause is fixed.

## 5. Read API (GET) — added 2026-11-14

The other applications can also **read** from JVzPay. Every call needs the same service token
(`Authorization: Bearer <token>`); each group answers only its own application's token (another application's token
gets `403`). All answers are JSON. Dates are `YYYY-MM-DD`, times `HH:MM`, timestamps are Philippine time
(`+08:00`), amounts are numbers in pesos. Lists take `limit` (1–500, default 100) and `offset`. Errors are
`{ "status": "...", "error": "..." }` with `400` (bad parameter), `401` (token), `403` (wrong application),
`404` (not found). These endpoints never change data: to change something in JVzPay, send an event (§2).

### 5.1 Every application

| Method and path | What it returns |
|---|---|
| `GET /api/v1/health` | `{status:"ok", source}` — checks the address and token. |
| `POST /api/v1/events` | Send an event (§2). |
| `GET /api/v1/events/{event_id}` | Status of an event **you** sent: `status` (`processed`, `failed`, `received`), `error`, `attempts`, `result_ref`, `received_at`, `processed_at`. |
| `GET /api/v1/feed?after={sequence}&limit=50&event_type=` | Events JVzPay has **for you** (the same ones it pushes to your `/api/v1/events`), oldest first, each with a `sequence`. Keep `next_after` and pass it as `after` next time; repeat while `has_more` is true. Use it if your app cannot receive pushes yet. De-duplicate by `event_id`. |
| `POST /api/v1/auth/login` | Department sign-in (§3.1). |

### 5.2 HR (HR token only)

`{employee_id}` is always the **HR** employee id.

| Method and path | What it returns |
|---|---|
| `GET /api/v1/hr/employees?status=&department_code=` | JVzPay's copy of each employee (from HR's events) plus `account` (`registered`, `status`, `last_login_at`) — for reconciling the two systems. |
| `GET /api/v1/hr/employees/{employee_id}` | One employee, same fields. |
| `GET /api/v1/hr/employees/{employee_id}/leave-balances?year=` | Per leave type: `entitled_days`, `adjusted_days`, `used_days`, `pending_days`, `available_days`. |
| `GET /api/v1/hr/employees/{employee_id}/payslips` | Released payslips only: period, days worked, lates, lost hours, earnings, deductions, `net_pay`. |
| `GET /api/v1/hr/attendance?from=&to=&employee_id=` | Official attendance records (default this month; at most 93 days). |
| `GET /api/v1/hr/leave-requests?from=&to=&employee_id=&status=` | Leave applications touching the range, with both approval steps. |
| `GET /api/v1/hr/overtime?from=&to=&employee_id=&status=` | Overtime records in the range. |
| `GET /api/v1/hr/pending-approvals?request_type=` | Requests waiting for the department supervisor's **first approval** through HR (`leave`, `overtime`, `attendance_correction`, `leave_conversion`), with `supervisor_employee_id`. Answer each with a `RequestDecided` event. |
| `GET /api/v1/hr/payroll/periods?year=` | Payroll periods (kinsenas/katapusan and special) with pay and release dates and the run's status. |
| `GET /api/v1/hr/payroll/periods/{period_id}` | Totals of the period's payroll (overall and per department) once it is approved; before that `summary` is `null`. |

### 5.3 CRM (CRM token only)

| Method and path | What it returns |
|---|---|
| `GET /api/v1/crm/sales/{transaction_id}` | How a sale you sent was posted: `status` (`posted`, `cancelled`, `partially_refunded`, `refunded`), `journal_entry`, and the `receivable` with its `balance` if it was on account. |
| `GET /api/v1/crm/receivables?customer_ref=&status=` | Receivables; `status` is `unpaid`, `partially_paid`, `paid`, `voided` or `open` (unpaid + partially paid). |
| `GET /api/v1/crm/customers/{customer_ref}/balance` | `outstanding_balance`, `overdue_balance` and the open receivables — for a credit check before selling on account. |

### 5.4 Inventory (Inventory token only)

| Method and path | What it returns |
|---|---|
| `GET /api/v1/inventory/purchase-orders/{purchase_order_id}` | The purchase order as JVzPay has it, its goods receipts, supplier invoices (with three-way `match_status`) and the payments made on each. |
| `GET /api/v1/inventory/supplier-invoices?supplier_ref=&status=` | Accounts payable; `status` is `pending_approval`, `unpaid`, `partially_paid`, `paid`, `rejected`, `voided` or `open`. |
| `GET /api/v1/inventory/suppliers/{supplier_ref}/balance` | What JVzPay still owes the supplier: `outstanding_balance`, `overdue_balance`, open invoices. |

## 6. Connecting locally (all four apps on one computer)

1. Run each app on its own port. JVzPay uses `PORT` in `.env` (currently `3002`), so its base address is
   `http://localhost:3002/api/v1`. Give HR, CRM and Inventory different ports.
2. **Tokens other apps use to call JVzPay:** sign in to JVzPay as Accounting Supervisor → *System → Integration* →
   create one token each for `johnvivz_hr`, `johnvivz_crm`, `johnvivz_inventory`. Each is shown once; give it to that
   app's developer to put in their `.env`.
3. **Tokens JVzPay uses to call the other apps:** in JVzPay's `.env`, set `HR_API_URL` (e.g. `http://localhost:3001`,
   no `/api/v1`), `HR_API_TOKEN`, and the same for `CRM_` and `INVENTORY_`. Each app must accept
   `POST {URL}/api/v1/events` with that token. Restart JVzPay after editing `.env`.
4. Test: `curl -H "Authorization: Bearer <token>" http://localhost:3002/api/v1/health`.
