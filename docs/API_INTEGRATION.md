# JVzPay integration API (version 1)

For the HR, CRM and Inventory developers. JVzPay is the JOHNVIVZ **Accounting & Payroll** application.
The four applications keep separate databases and never read each other's tables; they talk only through the
calls below. Field names and event types are a proposal from the Accounting team: confirm them together before
coding, and record any change here.

**Status (2026-11-16, team decisions):** the HR laptop hosts the test session. **HR is pull-only** (it sends no events
and has no `/events` endpoint): JVzPay reads HR's records (§3.2) and asks HR to confirm every ESS registration (§3.1).
**Inventory does not push**: JVzPay polls its outbox (§3.3). **CRM** pushes signed events (§1a, §2.2) and signs its staff
in through JVzPay's department login (§3.1). **Approvals are done in ESS** (§3.4), never through HR.

## 1. Authentication and addresses

**Two base paths, same API:** `/api/v1/...` and `/api/integration/v1/...` (the path of the CRM integration contract
v0.4.1). Every endpoint below answers on both.

Every call proves which application is calling, in **one** of two ways.

**a) Signed request (the CRM integration contract §2; recommended).** Three headers:

```
X-JVZ-Client: johnvivz_crm | johnvivz_hr | johnvivz_inventory          (the sender)
X-JVZ-Timestamp: 2026-11-13T09:30:00.000+08:00                          (ISO-8601 with an offset; Z is fine)
X-JVZ-Signature: hex(HMAC_SHA256(secret, METHOD + "\n" + path + "\n" + timestamp + "\n" + sha256hex(body)))
```

* `path` is the request target exactly as sent, **including the query string**; `body` is the raw body ("" if none).
* The secret is one per application and per direction, kept in `.env` on both sides, never in code or logs. In JVzPay
  the secret an app uses to call JVzPay is `CRM_INBOUND_SECRET`, `HR_INBOUND_SECRET` or `INVENTORY_INBOUND_SECRET`
  (CRM calls its copy `JVZ_SECRET_ACCOUNTING`). Generate it with `openssl rand -hex 32` and hand it over privately.
* Refused with `401 {"error": "unauthorized" | "invalid_signature" | "stale_timestamp" | "replayed_request"}`:
  unknown sender or missing headers, wrong signature, more than 5 minutes from JVzPay's clock, or a signature JVzPay
  already accepted. **Sign every attempt anew**, including retries.

**b) Bearer service token (JVzPay's original method; still accepted).**

```
Authorization: Bearer <token>
Content-Type: application/json
```

* Each application gets its **own** token. The Accounting Supervisor creates it in JVzPay under
  *System → Integration*, where it is shown once. JVzPay stores only a SHA-256 hash of it.
* A token is tied to one source (`johnvivz_hr`, `johnvivz_crm` or `johnvivz_inventory`). An event whose `source`
  does not match the token is refused.

Either way, a credential is valid only for its own application. Use HTTPS between servers in production.

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

`schema_version` must be `1` (or left out). Answers to a **signed** request follow the CRM contract:

| Response (signed request) | Meaning |
|---|---|
| `202 {"status":"accepted","event_id","processing":"processed"}` | Stored and applied. |
| `202 {"status":"accepted","event_id","processing":"failed","error"}` | Stored, but it could not be applied (for example a sale whose totals do not add up). It stays in JVzPay's inbox for the Accounting Supervisor; `GET /events/{event_id}` shows it. **Do not resend it**: a resend is a duplicate. |
| `200 {"status":"duplicate","event_id"}` | The same `event_id` (or `idempotency_key`) was already received; nothing was applied twice. |
| `400 {"error":"invalid_envelope","details":[…]}` | The envelope is invalid, `source` does not match the sender, `schema_version` is not 1, or the sender may not send that event type. Do not retry the same bytes. |
| `401 {"error":…}` | See §1a. |

Answers to a **bearer-token** request:

| Response (bearer token) | Meaning |
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
**HR does not send these events today** (it is pull-only): JVzPay pulls the same data (§3.2) and applies it through
these same handlers. The event endpoint still accepts them, so HR can push later without changes in JVzPay.

| `event_type` | `data` |
|---|---|
| `EmployeeCreated`, `EmployeeUpdated` | `employee_id` (HR id), `employee_no`, `first_name`, `middle_name`, `last_name`, `suffix`, `birth_date`, `email`, `phone`, `department_code`, `department_name`, `position_title`, `employment_type` (`regular`, `probationary`, `contractual`, `part_time`), `employment_status` (`active`, `on_leave`, `suspended`, `resigned`, `terminated`), `date_hired`, `verification_reference` (the unique code HR generated; the new hire types it when registering), `effective_date`. `email` is the personal email the new hire must use to register. Optional `supervisor_employee_id`: the HR id of the immediate supervisor or team leader, who gives the first approval of the employee's requests. |
| `EmployeeStatusChanged` | `employee_id`, `employment_status`, `effective_date`, `separation_date` (when leaving) |
| `EmployeeCompensationApproved` | `employee_id`, `compensation_version_id`, `rate_basis` (`monthly` or `daily`), `basic_salary`, `pay_frequency` (`semi_monthly` or `monthly`), `allowances` (the complete approved list for this version, each `{ "code", "amount" }`; an empty list means no recurring HR allowance), `effective_date`, `approval_reference` |
| `DepartmentUpserted` | `department_code`, `department_name`, `is_active` |
| `PositionUpserted` | `department_code`, `position_title`, `is_active` |
| `RequestDecided` | `request_type` (`leave`, `attendance_correction`, `overtime`, `leave_conversion`), `request_no` (JVzPay's number), `decision` (`approved` or `rejected`), `approver_employee_id`, `approver_name`, `remarks` (required when rejecting), `decided_at`. **No longer used** (2026-11-16: approvals are done in ESS, §3.4). Kept only for requests that were routed to HR before that change. |
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

JVzPay accepts the **CRM integration contract v0.4.1** shapes (§4 there). Money is a decimal string in pesos,
times are ISO-8601 with an offset, quantities are numbers.

| `event_type` | `data` (contract shape) | What JVzPay posts |
|---|---|---|
| `SaleCompleted` | `sale_id`, `order_id`, `transaction_no`, `customer_id`, `completed_at`, `items[{line_no, product_id, sku, quantity, unit_price, discount_amount, line_total, is_vatable}]`, `discounts[{code, type, amount}]`, `totals{gross, discount_total, net}`, `payments[{method, reference_no, amount, paid_at}]`, `payment_status`, `currency` (`PHP`) | Dr Cash on Hand (paid) or Accounts Receivable (`on_account`) for `totals.net`, Dr Sales Discounts for `totals.discount_total` / Cr Sales Revenue (net of VAT), Cr Output VAT. Dated on the Philippine date of `completed_at`. |
| `SaleCancelled` | `order_id`, `sale_id` (`null` before completion), `reason`, `cancelled_at`, `release_items` | `sale_id` null: nothing to post (processed, no entry). Otherwise the sale's entry is reversed and an unpaid receivable voided. |
| `RefundRecorded` | `refund_id`, `sale_id`, `order_id`, `amount`, `reason`, `return_items`, `approved_by_employee_id`, `recorded_at` | Dr Sales Returns and Dr Output VAT (the refund's share of the sale's VAT) / Cr Cash on Hand. Paid sales only, up to the amount not yet refunded. |

Rules:

* **VAT is computed by Accounting** (contract §0). CRM confirmed (2026-11-16) that its prices **include 12% VAT**, so
  Output VAT = the vatable lines' amount after
  discounts × 12/112. A discount above the line discounts (an order-level discount) is spread over the lines in
  proportion to their amounts before VAT is taken out.
* `totals.gross` must equal the sum of `quantity × unit_price`; `totals.net` must equal `gross − discount_total`;
  each `line_total` must equal `quantity × unit_price − discount_amount`; every item needs `is_vatable` (true/false).
* `payment_status` is always **`paid`** (CRM confirmed 2026-11-16: an order is completed only after the payment is
  verified; no on-account and no part-paid sales). The sale is posted as cash. Any other value, or `payments` that do not
  cover `totals.net`, is stored as failed with the reason.
* JVzPay's key for a sale is `sale_id` (read it back with `GET /crm/sales/{sale_id}`).

The older JVzPay shape is still accepted: `transaction_id`, `transaction_date` (YYYY-MM-DD), `payment_status`,
`payment_method`, `customer_ref`, `lines[{product_ref, quantity, unit_price, discount, tax}]` (tax on top of the
price), `total_amount`; and `transaction_id`, `amount`, `date`, `reason` for cancellations and refunds.

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

Inventory does not push: JVzPay reads these from Inventory's outbox (§3.3). Inventory's own event names are accepted
too: `GoodsReceiptRecorded` (= `GoodsReceived`), and `PurchaseOrderCreated`, `PurchaseOrderUpdated`,
`PurchaseOrderCancelled`, `InventoryReturnReceived`, `RefundReported` (recorded, no accounting entry yet). The field
names accepted for Inventory's data are in §7.

## 3. Calls JVzPay makes to other applications

JVzPay calls `{APP}_API_URL + {APP}_API_PREFIX + path` (prefix default `/api/v1`; HR, CRM and Inventory use
`/api/integration/v1`). It proves who it is with signed `X-JVZ-*` headers when `{APP}_API_SECRET` is set (signed anew
on every attempt) and/or `Authorization: Bearer {APP}_API_TOKEN`. Timeout: 10 seconds.

| To | Call | When |
|---|---|---|
| HR | `POST /employees/verify` | Every ESS registration (§3.1). |
| HR | `GET /departments`, `GET /employees`, `GET /employees/{identifier}`, `GET /payroll/employees/{identifier}/compensation` | HR pull sync (§3.2). |
| Inventory | `GET /accounting/outbox`, `POST /accounting/outbox/{event_id}/ack` | Inventory outbox poll (§3.3). |
| CRM | — | Nothing (the CRM contract expects no event from Accounting yet). |

**Events JVzPay pushes** go to `POST {…}/events` with the §2 envelope (`source: "johnvivz_accounting"`, `occurred_at` in
`+08:00`) and an `Idempotency-Key` header. Any `2xx` counts as delivered; `400` stops at once; anything else is retried
after 1, 2, 4 … 60 minutes, at most 10 attempts. A per-application switch decides whether events are queued at all:
`HR_EVENTS_ENABLED` (default **false**: HR is pull-only and has no `/events` endpoint), `CRM_EVENTS_ENABLED`,
`INVENTORY_EVENTS_ENABLED` (default true). While a switch is off nothing is queued for that application, so nothing piles
up as failed; HR's `verify` call is not affected. If HR adds an `/events` endpoint later, `HR_EVENTS_ENABLED=true` sends:

| To | `event_type` | When |
|---|---|---|
| HR | `LeaveRecorded`, `AttendanceCorrected`, `OvertimeRecorded`, `LeaveConversionRecorded`, or `LeaveRejected`, `AttendanceCorrectionRejected`, `OvertimeRejected`, `LeaveConversionRejected` | Every final decision. Accounting/Payroll keeps the official attendance, leave and overtime record (owner's decision, 2026-11-11). |
| HR | `EmployeeAccountActivated` | A new hire registered and the account is active. |
| HR | `DependentEnrolled`, `BenefitEnrolled` | Payroll Staff verified a dependent or a benefit enrollment (`benefit_type` `hmo` or `life_accident`, `plan_name`, `coverage_amount`, `covered_dependents`, `beneficiaries`). |

*Not sent (planned only, no code):* `PayrollApproved`, `PayslipPublished`, `PayrollPaymentRecorded`, `JournalPosted`.
HR reads payroll periods, totals and released payslips with the read API (§5.2) instead.
*No longer sent:* `LeaveRequested`, `AttendanceCorrectionRequested`, `OvertimeRequested`, `LeaveConversionRequested` —
approvals are done in ESS (§3.4).

### 3.1 Employee accounts (team decision 2026-11-16)

1. **HR** encodes the new hire and generates the **Employee ID** (`JV-YYYY-NNNNN`) and the **Employee Unique Code**.
2. **CRM and Inventory** read new employees from HR and create a **deactivated** access account.
3. **ESS (JVzPay)**: the new hire opens `/register/employee`, enters name, Employee ID, department, position, unique code
   and the onboarding email, and chooses a password. JVzPay asks HR:

   `POST {HR}/api/integration/v1/employees/verify` with `Authorization: Bearer <JVzPay's key from HR>` and

   ```json
   { "employee_id": "JV-2026-00004", "full_name": "…", "email": "…", "department": "CRM System", "position": "Agent",
     "employee_code": "BAUTISTA11172026", "verification_reference": "ESS-REG-…" }
   ```

   All 7 fields are required strings (HR's `integration-api-HR.md`). `employee_id` is the Employee ID
   (JV-<year hired>-<5-digit number>), `employee_code` the Employee Unique Code (LASTNAME + hire date MMDDYYYY), and
   `verification_reference` JVzPay's own id for this registration attempt (it is in HR's audit log and in JVzPay's).

   | HR's answer | What the new hire sees |
   |---|---|
   | `200 {"match": true, "eligible": true, "employee": {...}}` | The account is created at once. |
   | `200 {"match": false, "mismatches": ["email", …]}` | Which fields do not match (never HR's values). |
   | `200 {"match": true, "eligible": false}` | Not yet: HR must approve the onboarding, and the status must be Active or On Leave. |
   | `404 {"match": false}` | The Employee ID does not match. |
   | `400 {"errors": {...}}` | "Please check your details", naming the fields HR listed. |
   | no answer, or `5xx` | "The HR system could not be reached" — the registration is refused (no offline registration). |

   If the 15-minute sync has not brought the new hire yet, JVzPay takes the record from HR's list (by
   `permanent_employee_id`) or, for a new hire HR does not list yet, from the verify answer's `employee`.
4. **CRM and Inventory** sign their staff in with the department login below, and **activate** their own account on the
   first success.
5. **Resigned or Terminated** in HR (seen by the next sync): the ESS account is deactivated and its sessions ended, and
   the department login answers `403 not_allowed`. CRM and Inventory remove access in their own apps.

#### Department login — for the CRM and Inventory teams

`POST /api/integration/v1/auth/login` (also `/api/v1/auth/login`)

* **CRM:** signed request (§1a) with `X-JVZ-Client: johnvivz_crm`, secret = JVzPay's `CRM_INBOUND_SECRET`
  (CRM's `JVZ_SECRET_ACCOUNTING`).
* **Inventory:** `Authorization: Bearer <token>`, created by JVzPay's Accounting Supervisor on *System → Integration*
  for `johnvivz_inventory`.
* Rate limit: 60 attempts per 15 minutes per client address. Every attempt (accepted or refused) is in JVzPay's audit log.

Request:

```json
{ "email": "new.hire@example.com", "password": "…" }
```

| Answer | When |
|---|---|
| `200` (below) | Correct email and ESS password; the employee belongs to **your** department, is registered in ESS, and is Active or On Leave in HR. |
| `401 {"error":"invalid_credentials"}` | Wrong email or password, an employee who has not registered in ESS, or an account locked after too many wrong passwords. The answer is the same in every case, so nobody can tell which. |
| `403 {"error":"not_allowed"}` | The password is right, but the employee belongs to another department, is Resigned/Terminated/Suspended in HR, or the ESS account was deactivated. |
| `401 {"error":"unauthorized" \| "invalid_signature" \| "stale_timestamp" \| "replayed_request"}` | Your service credentials are missing or wrong (§1). |
| `429 {"error":"rate_limited"}` | Too many attempts. |

`200` answer (always exactly these fields):

```json
{
  "employee_id": "JV-2026-00012",
  "employee_code": "QX-5521-AB",
  "full_name": "Andrea L. Bautista",
  "email": "new.hire@example.com",
  "department_code": "CRM",
  "department_name": "Customer Relation Management",
  "position": "Agent",
  "employment_status": "active",
  "ess_registered_at": "2026-11-16T09:30:00+08:00"
}
```

`employee_id` is HR's JV number; `employee_code` is HR's Employee Unique Code (`null` if HR's records did not include
it); `employment_status` is `active` or `on_leave`. **Never returned:** salary, bank, government ID or password data.
Passwords never leave JVzPay; do not store them in your application. Which department codes count as "your
department" is set in JVzPay's `.env`: `CRM_DEPARTMENT_CODES` (default `CRM`), `INVENTORY_DEPARTMENT_CODES` (default
`INVENTORY`) — comma-separated, HR's codes. Payroll/Accounting employees sign in to JVzPay itself.

### 3.2 HR pull sync

HR sends no events. Every **15 minutes**, and when the Accounting Supervisor presses **Sync now** on *System →
Integration*, JVzPay reads (with `Authorization: Bearer HR_API_TOKEN`):

| Call | Used for |
|---|---|
| `GET /departments?page=1&per_page=100` | Departments (`code`, `name`, active flag). |
| `GET /employees?page=N&page_size=100` (every page) | The employee snapshot: name, email, department, position, status, hire date, unique code, supervisor. HR system accounts (no JV Employee ID) are skipped. |
| (registration) | A new hire HR confirmed: taken from HR's list, or from the verify answer when HR does not list them yet. |
| `GET /payroll/employees/{identifier}/compensation` (`HR_COMPENSATION_PATH`), for each employee read | Approved compensation (salary, rate basis, effective date, allowances). A `404` means HR has none for that employee yet. HR also has `GET /payroll/employees` and `GET /payroll/compensation-events`, which JVzPay does not read yet. |

Everything is applied through the **same code** as the HR events of §2.1 (`DepartmentUpserted`, `EmployeeCreated` /
`EmployeeUpdated`, `EmployeeStatusChanged`, `EmployeeCompensationApproved`), so the same rules hold: salary bands,
effective dates, payroll stops after the separation date. A status change in HR is applied as `EmployeeStatusChanged`
(employment history kept); **Resigned or Terminated deactivates the ESS account**. A salary version JVzPay already has is
not recorded twice. A record JVzPay cannot use (for example no position) is skipped and listed with the reason on the
Integration page; the others are still saved. The accepted field names are in §7.

### 3.3 Inventory outbox poll

Inventory does not push events. Every **minute** (and on **Poll now**) JVzPay calls
`GET /accounting/outbox?limit=100` (`Authorization: Bearer INVENTORY_API_TOKEN`), stores each event in its inbox exactly
like a pushed event (same `event_id` duplicate protection, same handlers, same retry on the Integration page), then calls
`POST /accounting/outbox/{event_id}/ack`. An event is acknowledged once it is **stored**, whether it posted or failed (a
failed one is retried in JVzPay, not re-sent by Inventory). An item that is not a valid event (no `event_id` or
`event_type`) is not acknowledged and is listed on the Integration page. `INVENTORY_POLL_ENABLED=false` switches it off.
The poll uses **only Inventory's own token** (`INVENTORY_API_TOKEN`, created by Inventory for JVzPay). It refuses to run
when that token is missing or is the same as one of CRM's credentials. (The token Inventory uses to call JVzPay's
department login is a different one, created on JVzPay's *System → Integration*.)

| Inventory event | What JVzPay does |
|---|---|
| `PurchaseOrderApproved` | Purchase order reference for three-way matching (`PurchaseOrderApproved`). |
| `GoodsReceiptRecorded` | Goods receipt reference (JVzPay's `GoodsReceived`). |
| `PurchaseOrderCreated` | Recorded, no entry: a purchase order counts once it is approved. |
| `PurchaseOrderUpdated` | Recorded, no entry: no agreed accounting effect yet. |
| `PurchaseOrderCancelled` | Recorded, no entry: the teams still have to agree how a cancellation closes the reference. |
| `InventoryReturnReceived` | Recorded, no entry: no agreed accounting entry yet (customer refunds are posted from CRM's `RefundRecorded`). |
| `RefundReported` | Recorded, no entry: refunds are posted once, from CRM's `RefundRecorded`. |

**Events JVzPay can use that Inventory does not send** (for the two teams to agree on): `SupplierInvoiceReceived`
(supplier invoice → accounts payable with three-way match), `StockAdjusted` (stock gain/loss posting),
`InventoryValuationReported` (valuation check against the books).

### 3.4 Approvals (team decision 2026-11-16)

All approvals are done in ESS; **nothing is routed to HR**. For leave, overtime, attendance corrections and vacation
leave conversion:

1. **First approval**, under *Team Approvals* in ESS:
   * the immediate supervisor named by HR (`supervisor_employee_id`), when they work in the **same department** and have
     an active ESS account;
   * otherwise the department's **supervisors/managers ranked above the requester**, any one of them with an ESS account
     (`DEPARTMENT_SUPERVISOR_TITLES`, highest first):

     | Department | Supervisor titles |
     |---|---|
     | CRM | CRM Manager, Team Leader |
     | Inventory | Inventory Manager, Inventory Supervisor |
     | HR | HR Manager, HR Supervisor |
     | Accounting/Payroll | Accounting Supervisor |

     An Agent's request goes to the CRM Manager and the Team Leader; a Team Leader's request goes to the CRM Manager.
2. **Final approval:** Accounting/Payroll.

**Straight to the final approval** (the reason is shown to the final approver): the department's top title (for
example the CRM Manager or an Accounting Supervisor), or nobody above the requester with an active ESS account yet.
Nobody approves their own request, and nobody gives both approvals of one request.

**Roles in JVzPay** (`POSITION_ROLES`): in Payroll/Accounting, Accounting Supervisor → Accounting Supervisor, Accounting
Staff → Accounting Staff, Payroll Staff → Payroll Staff. Every other title, in every department, gets the Employee (ESS)
role.

## 4. Monitoring

*System → Integration* in JVzPay shows every event received and sent, with its status (processed, duplicate,
failed, pending, not connected), the error, the number of attempts and the correlation id. Failed inbound events
can be retried there after the cause is fixed.

## 5. Read API (GET) — added 2026-11-14

The other applications can also **read** from JVzPay. Every call needs the same credentials as §1 (a signed request
or `Authorization: Bearer <token>`); each group answers only its own application (another application gets `403`). All answers are JSON. Dates are `YYYY-MM-DD`, times `HH:MM`, timestamps are Philippine time
(`+08:00`), amounts are numbers in pesos. Lists take `limit` (1–500, default 100) and `offset`. Errors are
`{ "status": "...", "error": "..." }` with `400` (bad parameter), `401` (token), `403` (wrong application),
`404` (not found). These endpoints never change data: to change something in JVzPay, send an event (§2).

### 5.1 Every application

| Method and path | What it returns |
|---|---|
| `GET /api/v1/health` | `{status:"ok", app, source, as_of}` — checks the address and the credentials (signed or token). |
| `POST /api/v1/events` | Send an event (§2). |
| `GET /api/v1/events/{event_id}` | Status of an event **you** sent: `status` (`processed`, `failed`, `received`), `error`, `attempts`, `result_ref`, `received_at`, `processed_at`. |
| `GET /api/v1/feed?after={sequence}&limit=50&event_type=` | Events JVzPay has **for you** (the same ones it pushes to your `/api/v1/events`), oldest first, each with a `sequence`. Keep `next_after` and pass it as `after` next time; repeat while `has_more` is true. Use it if your app cannot receive pushes yet. De-duplicate by `event_id`. |
| `POST /api/v1/auth/login` | Department sign-in (§3.1). |
| `POST /api/integration/v1/test/echo` | Connection test for a signed request **with a body**: answers `200 {status:"ok", app, source, signed, method, path, received_at, body_sha256, echo}` with the body exactly as received (wrong signature: `401`). Stores nothing. Used by CRM's `check-connections`. |

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

## 6. Connecting the apps (one computer, or several laptops on the same Wi-Fi)

1. **Address.** JVzPay listens on **port 3002** (`PORT` in `.env`, default 3002) on every network address. At start-up
   it prints the addresses other laptops can use, e.g. `http://192.168.1.15:3002`. Its API is that address plus
   `/api/integration/v1` (or `/api/v1`). On Windows, allow the port in Windows Defender Firewall (private network).
2. **How other apps prove who they are to JVzPay** (pick one per app):
   * *Signed requests* (CRM contract): agree one secret per app, put it in JVzPay's `.env` as `CRM_INBOUND_SECRET`
     (or `HR_…`, `INVENTORY_…`) and in that app's `.env` (CRM: `JVZ_SECRET_ACCOUNTING`).
   * *Bearer token:* sign in to JVzPay as Accounting Supervisor → *System → Integration* → create a token for
     `johnvivz_hr`, `johnvivz_crm` or `johnvivz_inventory`. It is shown once; give it to that app's developer.
3. **How JVzPay reaches the other apps** (`.env`): `{APP}_API_URL` (base address, no API path), `{APP}_API_PREFIX`
   (`/api/integration/v1` for CRM; default `/api/v1`), and `{APP}_API_SECRET` (the secret that app expects from JVzPay;
   CRM calls it `JVZ_CRM_INBOUND_SECRET_ACCOUNTING`) and/or `{APP}_API_TOKEN`. Restart JVzPay after editing `.env`.
4. **Test:** from the other app's "Test connection" (signed `GET /api/integration/v1/health`), or
   `curl -H "Authorization: Bearer <token>" http://<JVzPay-address>:3002/api/integration/v1/health`.

### 6.1 Settings for the test session (HR laptop hosts; HR port 3001, JVzPay port 3002)

| Team | Setting in **their** app | Value |
|---|---|---|
| **HR** | API key for Accounting | A key HR creates; give it to Accounting privately (JVzPay's `HR_API_TOKEN`). |
| **HR** | Endpoints JVzPay calls | `GET /api/integration/v1/departments`, `/employees`, `/employees/{identifier}`, `/payroll/employees/{identifier}/compensation`; `POST /api/integration/v1/employees/verify` (§3.1–3.2). |
| **CRM** | Accounting base URL | `http://<JVzPay-laptop-IP>:3002` + `/api/integration/v1` |
| **CRM** | `JVZ_SECRET_ACCOUNTING` | Shared secret = JVzPay's `CRM_INBOUND_SECRET` (signs events and the department login). |
| **CRM** | `INTEGRATION_ACCOUNTING_MODE` | `live` |
| **Inventory** | Accounting base URL | `http://<JVzPay-laptop-IP>:3002` + `/api/integration/v1` (department login only) |
| **Inventory** | Bearer token for JVzPay | Created on JVzPay *System → Integration* for `johnvivz_inventory`. |
| **Inventory** | Token JVzPay uses to read the outbox | A token Inventory creates; give it to Accounting privately (JVzPay's `INVENTORY_API_TOKEN`). |

JVzPay's own `.env` for the session (names only; secrets are exchanged privately, never in chat or git):

```
PORT=3002
HR_API_URL=http://<HR-laptop-IP>:3001
HR_API_PREFIX=/api/integration/v1
HR_API_TOKEN=<key from HR>
HR_EVENTS_ENABLED=false
HR_COMPENSATION_PATH=/payroll/employees/{identifier}/compensation
CRM_INBOUND_SECRET=<shared secret with CRM>
CRM_DEPARTMENT_CODES=CRM
INVENTORY_API_URL=http://<Inventory-laptop-IP>:<port>
INVENTORY_API_PREFIX=/api/integration/v1
INVENTORY_API_TOKEN=<token from Inventory>
INVENTORY_DEPARTMENT_CODES=INVENTORY
INVENTORY_POLL_ENABLED=true
ACCOUNTING_DEPARTMENT_CODE=ACCOUNTING
POSITION_ROLES=Accounting Supervisor=accounting_supervisor,Accounting Staff=accounting_staff,Payroll Staff=payroll_staff
DEPARTMENT_SUPERVISOR_TITLES=CRM=CRM Manager|Team Leader;INVENTORY=Inventory Manager|Inventory Supervisor;HR=HR Manager|HR Supervisor;ACCOUNTING=Accounting Supervisor
```

The department login accepts **Active and On Leave** employees of every department (team decision); Suspended,
Resigned and Terminated are refused with `403 not_allowed`.

## 7. Field names JVzPay accepts from HR and Inventory

**HR (from HR's live API, read 2026-11-17; `services/hrMapping.js`).** The guessed alternatives were removed.

| What | HR's answer |
|---|---|
| Lists | `{success, data: {items: [...], page, page_size, total, total_pages}}` (JVzPay sends `?page=&page_size=100`); departments `{success, data: [...]}` |
| One record | `{success, data: {...}}`; `404` when unknown |
| Department | `department_id`, `department_code`, `department_name` (codes: `HR`, `ACCOUNTING`, `CRM`, `INVENTORY`) |
| Employee | `employee_id` (**HR's internal number**, used in HR's URL paths), `permanent_employee_id` (**the JV Employee ID**, JVzPay's key), `employee_code` (unique code), `first_name`, `last_name`, `full_name`, `email`, `phone_number`, `department` {`department_id`, `department_code`, `department_name`}, `position` (text), `employment_type`, `work_schedule`, `reporting_supervisor_id` (HR's internal number of the supervisor, turned into their JV number), `hire_date`, `status` (Active, On Leave, Suspended, Resigned, Terminated) |
| System accounts | Records without `permanent_employee_id` (HR's own users) are skipped. |
| Compensation | `GET /payroll/employees/{employee_id}/compensation` → `data.compensation` {`as_of`, `compensation_version_id`, `basic_salary`, `compensation_basis` (monthly/daily), `components`, `fixed_monthly_total`}. A salary JVzPay already pays (same amount and basis) is not recorded again; a changed one is recorded effective on `as_of`. |
| Separation date | HR sends none: a Resigned/Terminated status is dated on the day the sync sees it. |
| Verify | see §3.1 |

Not yet seen in a live answer (to confirm with HR): the item shape of `components` (code + amount assumed), the
`employment_type` values, and the `employee` object of a matching verify (the employee shape above assumed).

**Inventory.** Still pending: Inventory's `docs/api.md` (its laptop could not be reached on 2026-11-17). Until then each
field accepts the names below (first match wins); only `services/inventoryMapping.js` changes when the docs arrive.

**Inventory outbox:** `events`, `items`, `data`, `outbox`, or a bare array; each item `event_id`/`id`/`uuid`,
`event_type`/`type`/`name`, `data`/`payload`, `occurred_at`/`created_at`, optional `idempotency_key`, `correlation_id`.

| JVzPay field | Inventory names accepted |
|---|---|
| Purchase order | `purchase_order_id`, `po_id`, `po_number`, `purchase_order_no`, `id` |
| Supplier | `supplier_ref`, `supplier_id`, `supplier.code`, `supplier.id`, `supplier_code`; name `supplier_name`, `supplier.name` |
| Order date | `order_date`, `po_date`, `approved_at`, `created_at`, `date` |
| Goods receipt | `goods_receipt_id`, `receipt_id`, `grn_id`, `grn_number`, `receipt_no`, `id`; date `received_date`, `received_at`, `receipt_date`, `date` |
| Lines | `lines` or `items`, each `product_ref`/`product_id`/`sku`, `quantity`/`qty`/`quantity_received`/`received_quantity`/`quantity_ordered`, `unit_cost`/`cost`/`unit_price`/`price` |
| Total | `total_amount`, `total`, `grand_total`, `total_cost` (else the sum of the lines) |
