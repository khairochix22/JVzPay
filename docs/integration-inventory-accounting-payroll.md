# Integration inventory: Accounting/Payroll (ESS) team, app "JVzPay"

Prepared 2026-11-14 for the JOHNVIVZ CRM developer. This report only describes what is **really in the code** of
this repository. **Last updated: 2026-11-14, after JVzPay was aligned with the CRM contract.** Every section below
describes the code after that change.

**What changed on 2026-11-14 (aligned with the CRM contract v0.4.1):**

| Area | Before | Now |
|---|---|---|
| Authentication | Bearer token only | Signed `X-JVZ-Client` / `X-JVZ-Timestamp` / `X-JVZ-Signature` (contract §2, with 5-minute window and replay refusal), in both directions. The bearer token still works. |
| API path | `/api/v1/...` only | `/api/integration/v1/...` **and** `/api/v1/...` |
| CRM sale events | Only JVzPay's own shape (`transaction_id`, `lines`, `total_amount`); contract events failed (422) | Contract shape of `SaleCompleted`, `SaleCancelled`, `RefundRecorded` (keyed by `sale_id`); the old shape still works |
| VAT | Taken from the sender's `tax`; none computed | **Computed by Accounting**: 12% included in the price, × 12/112 on the `is_vatable` lines; refunds reverse their share |
| Answers to CRM | `422` when stored but not applied | Contract codes: `202 accepted` (with `processing: processed/failed`), `200 duplicate`, `400 invalid_envelope`, `401 <code>` |
| Outgoing calls | Fixed `/api/v1/events`, bearer token, 10 retries even on `400` | Configurable path per app, signed and/or bearer, `Idempotency-Key`, `400` stops at once, `+08:00` timestamps |
| Port | Default 3000 (developer used 3002) | **3002** everywhere; start-up prints the Wi-Fi addresses |
| Migrations | Git-ignored (`*.sql`) | Allowed by `.gitignore` (still to be **committed**) |
| Docs | Listed 4 outgoing events that the code never sends | Marked "planned only" in `docs/API_INTEGRATION.md` |

New files: `lib/serviceSignature.js` (signatures), `services/crmSaleMapping.js` (contract sale → posting, VAT),
`tests/integrationContract.test.js`. Changed: `index.js`, `config/env.js`, `.env.example`, `.gitignore`,
`scripts/setup.js`, `middleware/apiClient.js`, `controllers/integration/eventsApiController.js`,
`services/integrationService.js`, `services/salesPurchasingHandlers.js`, `services/essRegistrationService.js`,
`tests/e2e/17-finance.mjs`, `tests/e2e/run.js`, `docs/API_INTEGRATION.md`, `docs/ARCHITECTURE.md`.

**Update 2026-11-16 (team-agreed employee account flow).** These changes are documented in full in
[docs/API_INTEGRATION.md](API_INTEGRATION.md) §3.1–§3.4, §6.1 and §7. Sections 1–8 below still describe the CRM
contract alignment of 2026-11-14, which is unchanged.

| Area | Now |
|---|---|
| ESS registration | HR confirms every registration (`POST {HR}/employees/verify`); only `match` + `eligible` registers; mismatched fields are named, HR's values never shown; HR unreachable = refused. |
| HR data | HR is pull-only: JVzPay reads `/departments`, `/employees`, `/payroll/compensation` every 15 minutes (and on **Sync now**) through the same code as the HR events. Resigned/Terminated deactivates the ESS account. |
| Events to HR | Off (`HR_EVENTS_ENABLED=false`): nothing is queued for HR. |
| Approvals | All in ESS: the supervisor/Team Leader in the same department first, then Accounting/Payroll. No supervisor in the department → straight to the final approval. Never routed to HR. |
| **Department login (for CRM)** | `POST /api/integration/v1/auth/login`, signed with `CRM_INBOUND_SECRET`. `200 {employee_id, employee_code, full_name, email, department_code, department_name, position, employment_status, ess_registered_at}`, `401 {"error":"invalid_credentials"}`, `403 {"error":"not_allowed"}`. Replaces the old `{authenticated, user}` answer. |
| Inventory | Polled: `GET /accounting/outbox` + `POST /accounting/outbox/{id}/ack`; `GoodsReceiptRecorded` → `GoodsReceived`. |
| Database | New migration `026_hr_pull_sync_ess_approvals.sql` (adds `employees.hr_employee_code`, moves requests that waited for HR into ESS). Migrations 001–025 are committed. |
| Answered by CRM | Prices include 12% VAT; `payment_status` is always `paid` (no on-account, no part-paid sales). |
| Roles and approvers | Position → role (`POSITION_ROLES`) and each department's supervisor titles (`DEPARTMENT_SUPERVISOR_TITLES`) are settings; see `docs/API_INTEGRATION.md` §3.4. |

- Compared against: the CRM team's **"JOHNVIVZ CRM — Integration Contract" v0.4.1 (Draft, 2026-11-14)**.
  Note: that file is **not** in this repository (`docs/integration-contract.md` does not exist here); the
  comparison uses the copy the CRM team shared.
- This app's own API description is [docs/API_INTEGRATION.md](API_INTEGRATION.md), updated with the same changes.
- No secrets, passwords, tokens or personal data are included.

---

## 1. App basics

| Item | Value |
|---|---|
| App name | **JVzPay**: JOHNVIVZ Accounting & Payroll, with Employee Self-Service (ESS) built in (`package.json` name `JVzPay`, version 1.0.0) |
| Framework | XianFire Framework (Node.js, ES modules). The XianFire version number is **not stated** anywhere in the code. Underneath: Express 4.19, Sequelize 6.37 with the `mysql2` driver, `hbs` (Handlebars) for the `.xian` templates. |
| Node version | Not pinned (no `engines` field, no `.nvmrc`). Minimum is **Node 18** (helmet 8 needs it, and the code uses the built-in `fetch` and `AbortSignal.timeout`). **Node 20 LTS or newer is recommended**; the test script (`node --test --test-concurrency=1`) needs Node 20.10+. The developer laptop has Node 24.14.1. |
| Port | **3002** (`PORT` in `.env`; the default in `config/env.js`, `.env.example` and `npm run setup`). |
| Listens on | **All network addresses.** `index.js` calls `server.listen(port)` with no host, so Node listens on every interface (IPv4 `0.0.0.0` and IPv6 `::`). At start-up it prints the LAN addresses other laptops can use (e.g. `http://192.168.x.x:3002`). Windows Firewall must allow the port. |
| HTTPS | Off by default. Turned on only when both `HTTPS_CERT_FILE` and `HTTPS_KEY_FILE` are set. For the Wi-Fi test it will be plain **http**. |
| Database | **MySQL**, database name **`JVzPay`** (`DB_NAME`). Laragon (the backup tool looks for MySQL in `C:/laragon/bin/mysql`; the installed version is MySQL 8.4.3). Not XAMPP. MariaDB was not tested and is not mentioned in the code. |
| Background jobs | Run inside the app process every minute (`lib/scheduler.js`): audit sealing, daily backup, hourly payroll auto-compute, and **sending queued integration events** (`deliverDue`). Turned off with `DISABLE_SCHEDULER=1`. |

### Install and start from a fresh copy

> **Note:** `database/migrations/*.sql` used to be git-ignored. `.gitignore` now makes an exception for them, but they
> reach a fresh `git clone` only after they are **committed**. Until then, copy the `database/migrations/` folder
> (25 files, `001_…` to `025_…`) from the developer's laptop by hand.

```bash
# 1. Get the code (git clone, or copy the folder), then open a terminal in it
npm install

# 2. Create .env with fresh random secrets (it never overwrites an existing .env)
npm run setup
#    Then edit .env: set PORT, DB_HOST/DB_PORT/DB_USER/DB_PASSWORD if not Laragon defaults,
#    and fill in the integration lines (CRM_INBOUND_SECRET, CRM_API_URL, …; see section 6).

# 3. Start MySQL in Laragon, then create the database and tables
npm run migrate          # creates database JVzPay if missing and applies database/migrations/*.sql in order

# 4. Load the base configuration (roles, permissions, chart of accounts, settings, first Accounting Supervisor)
npm run seed

# 5. Start the app
npm start                # production-style:  node index.js
# or
npm run dev              # with auto-reload (nodemon)
```

Check that it is up: open `http://<laptop-IP>:3002/healthz`, which answers `{"status":"ok","database":"ok",…}`
(no login). The integration API check is `GET http://<laptop-IP>:3002/api/integration/v1/health`, signed or with a
bearer token (section 6.2).

---

## 2. All routes / endpoints

**What "Auth" means below:**
- **none**: public.
- **guest**: public, but only when *not* signed in (signed-in users are redirected to the dashboard).
- **session**: signed-in browser session (cookie `jvzpay.sid`) plus a CSRF token on every POST. The permission
  needed is in brackets. Without a session you are redirected to `/login`.
- **service**: service-to-service API only (no session, no CSRF). Either signed `X-JVZ-Client` / `X-JVZ-Timestamp` /
  `X-JVZ-Signature` headers (CRM contract §2) or `Authorization: Bearer <service token>`.

**What "Returns" means:** HTML = rendered page. Redirect = a POST that does its work and then redirects to an HTML
page (normal web form). JSON, PDF, XLSX, file = as named.

Static files are also served from `/public` (CSS, JS, images) and `/vendor/chartjs`, with no login.

### 2.1 Service-to-service API (`/api/v1` and `/api/integration/v1`), the part the other apps use

Mounted **before** sessions and CSRF (`index.js`). **Every row below answers on both prefixes**: `/api/v1/...` and
`/api/integration/v1/...`. In the Auth column, "token" means a signed request **or** a bearer token. Rate limit:
600 requests per minute; `/auth/login` is limited to 60 per 15 minutes.

| Method | URL path | Controller / function | Auth | What it does | Returns |
|---|---|---|---|---|---|
| GET | `/api/v1/health` | `eventsApiController.health` | token (any app) | Checks the address and the credentials; says which app is calling (`{status:"ok", app, source, as_of}`) | JSON |
| POST | `/api/v1/events` | `eventsApiController.receive` | token (any app) | Receives one event from HR, CRM or Inventory, stores it, and applies it (answers in section 3) | JSON |
| POST | `/api/v1/auth/login` | `eventsApiController.departmentLogin` | token (any app) | Checks an employee's email and password for a department app (CRM token accepts only CRM-department employees) | JSON |
| GET | `/api/v1/events/:eventId` | `eventsApiController.eventStatus` | token (any app) | Status of an event **your** app sent (processed / failed + error) | JSON |
| GET | `/api/v1/feed` | `eventsApiController.feed` | token (any app) | Events JVzPay has queued **for your** app, to poll instead of receiving pushes (`?after=&limit=&event_type=`) | JSON |
| GET | `/api/v1/hr/employees` | `hrApiController.employees` | token (HR only) | JVzPay's copy of the employees plus their ESS account status | JSON |
| GET | `/api/v1/hr/employees/:employeeId` | `hrApiController.employee` | token (HR only) | One employee (HR id) | JSON |
| GET | `/api/v1/hr/employees/:employeeId/leave-balances` | `hrApiController.leaveBalances` | token (HR only) | Leave balances for a year | JSON |
| GET | `/api/v1/hr/employees/:employeeId/payslips` | `hrApiController.payslips` | token (HR only) | Released payslip summaries of one employee | JSON |
| GET | `/api/v1/hr/attendance` | `hrApiController.attendance` | token (HR only) | Official attendance records in a date range | JSON |
| GET | `/api/v1/hr/leave-requests` | `hrApiController.leaveRequests` | token (HR only) | Leave applications in a date range | JSON |
| GET | `/api/v1/hr/overtime` | `hrApiController.overtime` | token (HR only) | Overtime records in a date range | JSON |
| GET | `/api/v1/hr/pending-approvals` | `hrApiController.pendingApprovals` | token (HR only) | Requests waiting for a department supervisor's first approval through HR | JSON |
| GET | `/api/v1/hr/payroll/periods` | `hrApiController.payrollPeriods` | token (HR only) | Payroll periods of a year and their run status | JSON |
| GET | `/api/v1/hr/payroll/periods/:periodId` | `hrApiController.payrollPeriodSummary` | token (HR only) | Totals of an approved payroll period, overall and per department | JSON |
| GET | `/api/v1/crm/sales/:transactionId` | `crmApiController.sale` | token (CRM only) | How a CRM sale was posted: `status`, `tax_amount`, journal entry number, receivable. `:transactionId` = CRM's `sale_id` | JSON |
| GET | `/api/v1/crm/receivables` | `crmApiController.receivables` | token (CRM only) | Accounts receivable from on-account sales (`?customer_ref=<CRM customer_id>&status=`) | JSON |
| GET | `/api/v1/crm/customers/:customerRef/balance` | `crmApiController.customerBalance` | token (CRM only) | A customer's outstanding and overdue balance. `:customerRef` = CRM's `customer_id` | JSON |
| GET | `/api/v1/inventory/purchase-orders/:purchaseOrderId` | `inventoryApiController.purchaseOrder` | token (Inventory only) | A purchase order with its receipts, supplier invoices and payments | JSON |
| GET | `/api/v1/inventory/supplier-invoices` | `inventoryApiController.supplierInvoices` | token (Inventory only) | Supplier invoices (accounts payable) | JSON |
| GET | `/api/v1/inventory/suppliers/:supplierRef/balance` | `inventoryApiController.supplierBalance` | token (Inventory only) | What JVzPay still owes a supplier | JSON |
| any | `/api/v1/*` (anything else) | inline in `routes/api.js` | none | Unknown API route | JSON 404 |

### 2.2 Public pages and system

| Method | URL path | Controller / function | Auth | What it does | Returns |
|---|---|---|---|---|---|
| GET | `/` | inline in `routes/index.js` | none | Sends you to `/dashboard` or `/login` | Redirect |
| GET | `/privacy` | `privacyNoticeController.page` | none | Privacy notice | HTML |
| GET | `/healthz` | `healthController.health` | none | Uptime check, including whether the database answers | JSON |
| GET | `/login` | `loginController.loginPage` | guest | Sign-in page | HTML |
| POST | `/login` | `loginController.loginUser` | guest (rate-limited) | Signs in | Redirect |
| GET | `/register` | `accountRequestController.page` | guest | Accounting staff account request form | HTML |
| GET | `/register/sent` | `accountRequestController.sentPage` | guest | "Request sent" page | HTML |
| POST | `/register` | `accountRequestController.submit` | guest (rate-limited) | Submits an accounting staff account request | Redirect |
| GET | `/register/employee` | `essRegistrationController.page` | guest | Employee ESS registration form (checked against HR's data) | HTML |
| POST | `/register/employee` | `essRegistrationController.submit` | guest (rate-limited) | Registers and activates an employee account | Redirect |
| GET | `/register/employee/done` | `essRegistrationController.donePage` | guest | Registration done page | HTML |
| GET | `/forgot-password` | `forgotPasswordController.forgotPasswordPage` | guest | Forgot-password information page | HTML |
| GET | `/reset-password/:token` | `resetPasswordController.page` | none (one-time link) | Reset-password form | HTML |
| POST | `/reset-password/:token` | `resetPasswordController.submit` | none (one-time link, rate-limited) | Sets a new password | Redirect |
| POST | `/logout` | `loginController.logoutUser` | session | Signs out | Redirect |
| GET | `/account/password` | `changePasswordController.passwordPage` | session | Change-password page | HTML |
| POST | `/account/password` | `changePasswordController.changePassword` | session | Changes the password | Redirect |
| GET | `/privacy/acknowledge` | `privacyAcknowledgeController.page` | session | Privacy acknowledgement page | HTML |
| POST | `/privacy/acknowledge` | `privacyAcknowledgeController.submit` | session | Records the acknowledgement | Redirect |
| POST | `/session/keepalive` | `sessionController.keepAlive` | session | Extends the session (inactivity warning) | 204, empty |
| POST | `/activity/print` | `printLogController.logPrinted` | session | Logs that a page was printed (audit) | 204, empty |
| GET | `/dashboard` | `dashboardController.dashboardPage` | session | Role-specific dashboard | HTML |

### 2.3 Users, audit, notifications, documents

| Method | URL path | Controller / function | Auth | What it does | Returns |
|---|---|---|---|---|---|
| GET | `/users/registrations` | `essActivationController.page` | session (`ess.activate`) | Log of employee self-registrations | HTML |
| GET | `/users` | `userListController.list` | session (`users.manage`) | User accounts list | HTML |
| GET | `/users/requests` | `accountRequestListController.queue` | session (`users.manage`) | Accounting staff account requests | HTML |
| GET | `/users/requests/:id` | `accountRequestReviewController.reviewPage` | session (`users.manage`) | Review one request | HTML |
| POST | `/users/requests/:id/decision` | `accountRequestReviewController.decision` | session (`users.manage`) | Approve or reject a request | Redirect |
| GET | `/users/:id/edit` | `userFormController.editForm` | session (`users.manage`) | Edit a user | HTML |
| POST | `/users/:id` | `userFormController.update` | session (`users.manage`) | Save user changes | Redirect |
| POST | `/users/:id/reset-password` | `userFormController.resetPassword` | session (`users.manage`) | Reset a user's password | Redirect |
| POST | `/users/:id/reset-link` | `userFormController.resetLink` | session (`users.manage`) | Create a one-time reset link | Redirect |
| POST | `/users/:id/unlock` | `userFormController.unlock` | session (`users.manage`) | Unlock a locked account | Redirect |
| POST | `/users/:id/revoke-sessions` | `userFormController.revokeSessions` | session (`users.manage`) | Sign the user out everywhere | Redirect |
| GET | `/audit` | `auditLogController.auditLog` | session (`audit.view` or `audit.view_payroll`) | Audit trail | HTML |
| GET | `/notifications` | `notificationController.list` | session | My notifications | HTML |
| POST | `/notifications/:id/read` | `notificationController.markRead` | session | Mark one as read | Redirect |
| POST | `/notifications/read-all` | `notificationController.markAllRead` | session | Mark all as read | Redirect |
| GET | `/documents/:id` | `documentController.download` | session (checked inside the controller) | Download a supporting document | file |
| GET | `/bank-enrollments` | `bankEnrollmentQueueController.queue` | session (`bank.review`) | Bank enrollment requests to review | HTML |
| GET | `/bank-enrollments/:id` | `bankEnrollmentReviewController.detailPage` | session (`bank.review`) | One bank enrollment | HTML |
| POST | `/bank-enrollments/:id/reveal` | `bankEnrollmentReviewController.reveal` | session (`bank.review`) | Show the full (encrypted) account number, audited | Redirect |
| POST | `/bank-enrollments/:id/decision` | `bankEnrollmentReviewController.decision` | session (`bank.review`) | Approve or reject | Redirect |

### 2.4 Employee Self-Service (`/my/...`), all need a session **and** a linked employee record

| Method | URL path | Controller / function | Auth | What it does | Returns |
|---|---|---|---|---|---|
| GET | `/my/profile` | `myProfileController.showProfile` | session (`self.profile`) | My profile | HTML |
| POST | `/my/profile` | `myProfileController.updateContact` | session (`self.profile`) | Update my contact details | Redirect |
| GET | `/my/payslips` | `myPayslipsController.listPayslips` | session (`self.payslips`) | My payslips | HTML |
| GET | `/my/payslips/:id` | `myPayslipController.payslipPage` | session (`self.payslips`) | One payslip | HTML |
| GET | `/my/payslips/:id/pdf` | `myPayslipController.payslipPdf` | session (`self.payslips`) | Payslip download | PDF |
| GET | `/my/attendance` | `myAttendanceController.showAttendance` | session (`self.attendance`) | My attendance | HTML |
| POST | `/my/attendance/corrections` | `myAttendanceController.requestCorrection` | session (`self.attendance`) | File an attendance correction (optional attachment) | Redirect |
| POST | `/my/attendance/corrections/:id/cancel` | `myAttendanceController.cancelCorrection` | session (`self.attendance`) | Cancel it | Redirect |
| GET | `/my/leave` | `myLeaveController.showLeave` | session (`self.leave`) | My leave and balances | HTML |
| POST | `/my/leave/applications` | `myLeaveController.applyLeave` | session (`self.leave`) | File a leave (optional attachment) | Redirect |
| POST | `/my/leave/applications/:id/cancel` | `myLeaveController.cancelLeave` | session (`self.leave`) | Cancel a leave | Redirect |
| POST | `/my/leave/conversion` | `myLeaveController.convert` | session (`self.leave`) | Ask to convert vacation leave to cash | Redirect |
| POST | `/my/leave/conversion/:id/cancel` | `myLeaveController.cancelConversionRequest` | session (`self.leave`) | Cancel that request | Redirect |
| GET | `/my/bank` | `myBankController.showBank` | session (`self.bank`) | My bank enrollment | HTML |
| POST | `/my/bank/requests` | `myBankController.submitBankRequest` | session (`self.bank`) | Submit bank details | Redirect |
| POST | `/my/bank/requests/:id/cancel` | `myBankController.cancelBankRequest` | session (`self.bank`) | Cancel it | Redirect |
| GET | `/my/government` | `myGovernmentController.page` | session (`self.enrollments`) | My government IDs (SSS, PhilHealth, Pag-IBIG, TIN) | HTML |
| POST | `/my/government/requests` | `myGovernmentController.submit` | session (`self.enrollments`) | Submit government ID details | Redirect |
| POST | `/my/government/requests/:id/cancel` | `myGovernmentController.cancel` | session (`self.enrollments`) | Cancel it | Redirect |
| GET | `/my/benefits` | `myBenefitsController.page` | session (`self.enrollments`) | My benefits and dependents | HTML |
| POST | `/my/benefits/dependents` | `myBenefitsController.addDependent` | session (`self.enrollments`) | Add a dependent | Redirect |
| POST | `/my/benefits/enrollments` | `myBenefitsController.enroll` | session (`self.enrollments`) | Enroll in a benefit | Redirect |
| POST | `/my/benefits/:kind/:id/cancel` | `myBenefitsController.cancel` | session (`self.enrollments`) | Cancel a dependent or benefit request (`kind` = dependent / benefit) | Redirect |
| GET | `/my/holidays` | `myHolidaysController.page` | session (`self.profile`) | Holiday calendar | HTML |
| GET | `/my/overtime` | `myOvertimeController.page` | session (`self.overtime`) | My overtime | HTML |
| POST | `/my/overtime/applications` | `myOvertimeController.apply` | session (`self.overtime`) | File overtime | Redirect |
| POST | `/my/overtime/applications/:id/cancel` | `myOvertimeController.cancel` | session (`self.overtime`) | Cancel it | Redirect |
| GET | `/my/clock` | `myClockController.page` | session (`self.attendance`) | Time clock | HTML |
| POST | `/my/clock/punch` | `myClockController.punch` | session (`self.attendance`) | Clock in or out | Redirect |
| GET | `/my/schedule` | `myScheduleController.page` | session (`self.attendance`) | My schedule (plotted by HR) | HTML |
| GET | `/my/schedule/live` | `myScheduleController.live` | session (`self.attendance`) | Small change-check the schedule page polls every 30 s | JSON |
| GET | `/my/retirement` | `myRetirementController.page` | session (`self.retirement`) | My retirement fund | HTML |
| POST | `/my/retirement/enroll` | `myRetirementController.enroll` | session (`self.retirement`) | Enroll | Redirect |
| POST | `/my/retirement/withdrawals` | `myRetirementController.withdraw` | session (`self.retirement`) | Request a withdrawal | Redirect |
| POST | `/my/retirement/withdrawals/:id/cancel` | `myRetirementController.cancel` | session (`self.retirement`) | Cancel it | Redirect |
| GET | `/my/loans` | `mySalaryLoanController.page` | session (`self.loans`) | My salary loans | HTML |
| POST | `/my/loans` | `mySalaryLoanController.apply` | session (`self.loans`) | Apply for a salary loan | Redirect |
| POST | `/my/loans/:id/cancel` | `mySalaryLoanController.cancel` | session (`self.loans`) | Cancel it | Redirect |

### 2.5 Approvals, attendance, leave, overtime

| Method | URL path | Controller / function | Auth | What it does | Returns |
|---|---|---|---|---|---|
| GET | `/team/approvals` | `teamApprovalsController.page` | session (`team.approve`, given to Accounting Supervisors and immediate supervisors) | First-approval queue | HTML |
| POST | `/team/approvals/:kind/:id/decision` | `teamApprovalsController.decision` | session (`team.approve`) | First approval of leave / overtime / attendance_correction / leave_conversion | Redirect |
| GET | `/attendance` | `attendanceRecordsController.records` | session (`attendance.view`) | Attendance records | HTML |
| GET | `/attendance/encode` | `attendanceEncodingController.encodeSheet` | session (`attendance.encode`) | Encoding sheet | HTML |
| POST | `/attendance/encode` | `attendanceEncodingController.saveEncoding` | session (`attendance.encode`) | Save encoded attendance | Redirect |
| GET | `/attendance/validation` | `attendanceValidationController.validationQueue` | session (`attendance.validate`) | Records to validate | HTML |
| POST | `/attendance/validation` | `attendanceValidationController.validateSelected` | session (`attendance.validate`) | Validate selected records | Redirect |
| GET | `/attendance/corrections` | `correctionQueueController.queue` | session (`attendance.correction.review` or `attendance.view`) | Correction requests | HTML |
| GET | `/attendance/corrections/:id` | `correctionReviewController.reviewPage` | session (same) | One correction | HTML |
| POST | `/attendance/corrections/:id/decision` | `correctionReviewController.decision` | session (`attendance.correction.review`) | Final decision on a correction | Redirect |
| GET | `/attendance/schedules` | `workSchedulesController.page` | session (`schedules.manage`) | Work schedules overview | HTML |
| GET | `/leave-requests` | `leaveQueueController.queue` | session (`leave.view` or `leave.review`) | Leave requests | HTML |
| GET | `/leave-requests/:id` | `leaveReviewController.reviewPage` | session (same) | One leave request | HTML |
| POST | `/leave-requests/:id/decision` | `leaveReviewController.decision` | session (`leave.review`) | Final decision on a leave | Redirect |
| GET | `/leave-calendar` | `leaveCalendarController.calendarPage` | session (`leave.view` or `leave.review`) | Leave calendar | HTML |
| GET | `/leave-types` | `leaveTypesController.typesPage` | session (`leave.config`) | Leave types | HTML |
| POST | `/leave-types` | `leaveTypesController.save` | session (`leave.config`) | Add a leave type | Redirect |
| POST | `/leave-types/:id` | `leaveTypesController.save` | session (`leave.config`) | Edit a leave type | Redirect |
| GET | `/leave-balances` | `leaveBalancesController.balances` | session (`leave.view` or `leave.config`) | Leave balances | HTML |
| POST | `/leave-balances/adjust` | `leaveBalancesController.adjust` | session (`leave.config`) | Adjust a balance | Redirect |
| GET | `/overtime` | `overtimeController.overtimePage` | session (`overtime.submit`, `overtime.approve` or `attendance.view`) | Overtime records | HTML |
| POST | `/overtime` | `overtimeController.encode` | session (`overtime.submit`) | Encode overtime | Redirect |
| GET | `/overtime/review` | `overtimeReviewController.reviewQueue` | session (`overtime.approve`) | Overtime to approve | HTML |
| POST | `/overtime/:id/decision` | `overtimeReviewController.decision` | session (`overtime.approve`) | Final decision on overtime | Redirect |

### 2.6 Payroll

| Method | URL path | Controller / function | Auth | What it does | Returns |
|---|---|---|---|---|---|
| GET | `/payroll` | `payrollController.page` | session (`payroll.view` or `payroll.periods`) | Payroll periods and runs | HTML |
| GET | `/payroll/periods`, `/payroll/batches` | inline | session | Old addresses, permanent redirect to `/payroll` | Redirect |
| POST | `/payroll/periods/month` | `payrollController.addMonth` | session (`payroll.periods`) | Create a month's periods | Redirect |
| POST | `/payroll/periods/special` | `payrollController.addSpecial` | session (`payroll.periods`) | Create a special period | Redirect |
| POST | `/payroll/periods/:id/compute` | `payrollController.compute` | session (`payroll.prepare`) | Compute payroll for a period | Redirect |
| GET | `/payroll/batches/:id` | `payrollBatchController.show` | session (`payroll.view`) | One payroll run | HTML |
| POST | `/payroll/batches/:id/recompute` | `payrollBatchController.recompute` | session (`payroll.prepare`) | Recompute | Redirect |
| POST | `/payroll/batches/:id/submit` | `payrollBatchController.submit` | session (`payroll.prepare`) | Submit for approval | Redirect |
| POST | `/payroll/batches/:id/approve` | `payrollBatchController.approve` | session (`payroll.approve`) | Approve | Redirect |
| POST | `/payroll/batches/:id/reject` | `payrollBatchController.reject` | session (`payroll.approve`) | Reject | Redirect |
| POST | `/payroll/batches/:id/finalize` | `payrollBatchController.finalize` | session (`payroll.finalize`) | Finalize | Redirect |
| POST | `/payroll/batches/:id/release` | `payrollBatchController.release` | session (`payroll.finalize`) | Release payslips | Redirect |
| POST | `/payroll/batches/:id/void` | `payrollBatchController.voidBatch` | session (`payroll.finalize`) | Void a run | Redirect |
| GET | `/payroll/records/:id` | `payrollRecordController.show` | session (`payroll.view`) | One employee's payroll record | HTML |
| GET | `/payroll/pay-items` | `payItemsController.page` | session (`payitems.submit`, `payitems.approve` or `payroll.view`) | Recurring pay items | HTML |
| POST | `/payroll/pay-items` | `payItemsController.create` | session (`payitems.submit`) | Add a pay item | Redirect |
| POST | `/payroll/pay-items/:id/end` | `payItemsController.end` | session (`payitems.submit` or `payitems.approve`) | End a pay item | Redirect |
| GET | `/payroll/pay-items/review` | `payItemReviewController.queue` | session (`payitems.approve`) | Pay items to approve | HTML |
| POST | `/payroll/pay-items/:id/decision` | `payItemReviewController.decision` | session (`payitems.approve`) | Approve or reject | Redirect |
| GET | `/payroll/adjustments` | `payrollAdjustmentsController.page` | session (`payroll.adjust.submit`, `payroll.adjust.approve` or `payroll.view`) | Payroll adjustments | HTML |
| POST | `/payroll/adjustments` | `payrollAdjustmentsController.create` | session (`payroll.adjust.submit`) | Add an adjustment | Redirect |
| GET | `/payroll/adjustments/review` | `payrollAdjustmentReviewController.queue` | session (`payroll.adjust.approve`) | Adjustments to approve | HTML |
| POST | `/payroll/adjustments/:id/decision` | `payrollAdjustmentReviewController.decision` | session (`payroll.adjust.approve`) | Approve or reject | Redirect |
| GET | `/payroll/enrollments` | `enrollmentReviewController.page` | session (`statutory.review` or `benefits.review`) | Government / dependent / benefit enrollments to verify | HTML |
| POST | `/payroll/enrollments/:kind/:id/decision` | `enrollmentReviewController.decision` | session (same) | Verify or reject (`kind` = statutory / dependent / benefit) | Redirect |
| GET | `/payroll/payslips` | `payslipListController.list` | session (`payslips.view_all`) | All payslips | HTML |
| GET | `/payroll/payslips/:id` | `payslipViewController.show` | session (`payslips.view_all`) | One payslip | HTML |
| GET | `/payroll/payslips/:id/pdf` | `payslipViewController.pdf` | session (`payslips.view_all`) | Payslip download | PDF |
| GET | `/payroll/salary-changes` | `salaryVerificationController.queue` | session (`employees.salary.verify`) | Salary changes to verify | HTML |
| POST | `/payroll/salary-changes/:id/decision` | `salaryVerificationController.decision` | session (`employees.salary.verify`) | Verify or reject | Redirect |
| GET | `/payroll/setup/statutory` | `statutoryRulesController.page` | session (`payroll.config`) | SSS / PhilHealth / Pag-IBIG rules | HTML |
| POST | `/payroll/setup/statutory` | `statutoryRulesController.add` | session (`payroll.config`) | Add a rule | Redirect |
| POST | `/payroll/setup/statutory/:id/verify` | `statutoryRulesController.verify` | session (`payroll.config`) | Verify a rule | Redirect |
| GET | `/payroll/setup/tax` | `taxTableController.page` | session (`payroll.config`) | Withholding tax table | HTML |
| POST | `/payroll/setup/tax` | `taxTableController.add` | session (`payroll.config`) | Add a bracket | Redirect |
| POST | `/payroll/setup/tax/verify` | `taxTableController.verify` | session (`payroll.config`) | Verify the table | Redirect |
| GET | `/payroll/setup/holidays` | `holidaysController.page` | session (`payroll.config`) | Holidays | HTML |
| POST | `/payroll/setup/holidays` | `holidaysController.save` | session (`payroll.config`) | Add a holiday | Redirect |
| POST | `/payroll/setup/holidays/:id` | `holidaysController.save` | session (`payroll.config`) | Edit a holiday | Redirect |
| POST | `/payroll/setup/holidays/:id/toggle` | `holidaysController.toggle` | session (`payroll.config`) | Turn a holiday on or off | Redirect |
| GET | `/payroll/setup/components` | `salaryComponentsController.page` | session (`payroll.config`) | Earning and deduction components | HTML |
| POST | `/payroll/setup/components` | `salaryComponentsController.add` | session (`payroll.config`) | Add a component | Redirect |
| POST | `/payroll/setup/components/:id/toggle` | `salaryComponentsController.toggle` | session (`payroll.config`) | Turn a component on or off | Redirect |
| GET | `/payroll/leave-conversions` | `leaveConversionsController.page` | session (`leave.conversion.review`) | Leave-to-cash requests | HTML |
| POST | `/payroll/leave-conversions/:id/decision` | `leaveConversionsController.decision` | session (`leave.conversion.review`) | Final decision | Redirect |
| GET | `/payroll/retirement` | `retirementFundController.page` | session (`retirement.manage` or `retirement.approve`) | Retirement fund | HTML |
| POST | `/payroll/retirement/withdrawals` | `retirementFundController.file` | session (`retirement.manage`) | File a withdrawal | Redirect |
| POST | `/payroll/retirement/withdrawals/:id/decision` | `retirementFundController.decision` | session (`retirement.approve`) | Approve or reject | Redirect |
| POST | `/payroll/retirement/withdrawals/:id/paid` | `retirementFundController.paid` | session (`retirement.manage`) | Mark paid | Redirect |
| GET | `/payroll/loans` | `salaryLoansController.page` | session (`loans.approve` or `loans.release`) | Salary loans | HTML |
| POST | `/payroll/loans/:id/decision` | `salaryLoansController.decision` | session (`loans.approve`) | Approve or reject a loan | Redirect |
| POST | `/payroll/loans/:id/release` | `salaryLoansController.doRelease` | session (`loans.release`) | Release a loan | Redirect |

### 2.7 Accounting

| Method | URL path | Controller / function | Auth | What it does | Returns |
|---|---|---|---|---|---|
| GET | `/accounting/accounts` | `chartOfAccountsController.page` | session (`accounting.view`) | Chart of accounts | HTML |
| POST | `/accounting/accounts` | `chartOfAccountsController.save` | session (`accounting.manage`) | Add an account | Redirect |
| POST | `/accounting/accounts/:id` | `chartOfAccountsController.save` | session (`accounting.manage`) | Edit an account | Redirect |
| POST | `/accounting/accounts/:id/toggle` | `chartOfAccountsController.toggle` | session (`accounting.manage`) | Activate / deactivate | Redirect |
| GET | `/accounting/categories` | `transactionCategoriesController.page` | session (`accounting.view`) | Transaction categories | HTML |
| POST | `/accounting/categories` | `transactionCategoriesController.add` | session (`accounting.manage`) | Add a category | Redirect |
| POST | `/accounting/categories/:id/toggle` | `transactionCategoriesController.toggle` | session (`accounting.manage`) | Activate / deactivate | Redirect |
| GET | `/accounting/income` | `incomeController.page` | session (`accounting.view` or `accounting.prepare`) | Income (revenue) entries | HTML |
| POST | `/accounting/income` | `incomeController.create` | session (`accounting.manage` or `accounting.prepare`) | Record income (optional attachment) | Redirect |
| POST | `/accounting/income/:id/void` | `incomeController.voidTxn` | session (`accounting.manage`) | Void it | Redirect |
| GET | `/accounting/expenses` | `expenseController.page` | session (`accounting.view` or `accounting.prepare`) | Expenses | HTML |
| POST | `/accounting/expenses` | `expenseController.create` | session (`accounting.manage` or `accounting.prepare`) | Record an expense (optional attachment) | Redirect |
| POST | `/accounting/expenses/:id/void` | `expenseController.voidTxn` | session (`accounting.manage`) | Void it | Redirect |
| GET | `/accounting/adjustments` | `accountingAdjustmentsController.page` | session (`accounting.manage` or `accounting.prepare`) | Adjusting entries | HTML |
| POST | `/accounting/adjustments` | `accountingAdjustmentsController.create` | session (same) | Propose an adjustment | Redirect |
| GET | `/accounting/approvals` | `accountingApprovalsController.queue` | session (`accounting.adjust.approve`) | Entries waiting for approval | HTML |
| POST | `/accounting/approvals/:id/decision` | `accountingApprovalsController.decision` | session (`accounting.adjust.approve`) | Approve or reject | Redirect |
| GET | `/accounting/journals` | `journalListController.list` | session (`accounting.view`) | Journal entries | HTML |
| GET | `/accounting/journals/:id` | `journalEntryController.show` | session (`accounting.view`) | One journal entry | HTML |
| GET | `/accounting/periods` | `financialPeriodsController.page` | session (`accounting.view`) | Financial periods | HTML |
| POST | `/accounting/periods/:id/close` | `financialPeriodsController.close` | session (`accounting.manage`) | Close a period | Redirect |
| POST | `/accounting/periods/:id/reopen` | `financialPeriodsController.reopen` | session (`accounting.manage`) | Reopen a period | Redirect |
| GET | `/accounting/payables` | `payablesController.page` | session (`payables.prepare` or `payables.approve`) | Accounts payable | HTML |
| POST | `/accounting/payables/suppliers` | `payablesController.addSupplier` | session (`payables.prepare`) | Add a supplier | Redirect |
| POST | `/accounting/payables/invoices` | `payablesController.createInvoice` | session (`payables.prepare`) | Record a supplier invoice | Redirect |
| POST | `/accounting/payables/invoices/:id/decision` | `payablesController.decide` | session (`payables.approve`) | Approve or reject an invoice | Redirect |
| POST | `/accounting/payables/invoices/:id/payments` | `payablesController.pay` | session (`payables.prepare`) | Record a payment | Redirect |
| POST | `/accounting/payables/invoices/:id/void` | `payablesController.voidInvoice` | session (`payables.approve`) | Void an invoice | Redirect |
| GET | `/accounting/receivables` | `receivablesController.page` | session (`receivables.manage`) | Accounts receivable | HTML |
| POST | `/accounting/receivables` | `receivablesController.create` | session (`receivables.manage`) | Add a receivable | Redirect |
| POST | `/accounting/receivables/customers` | `receivablesController.addCustomer` | session (`receivables.manage`) | Add a customer | Redirect |
| POST | `/accounting/receivables/:id/collections` | `receivablesController.collect` | session (`receivables.manage`) | Record a collection | Redirect |
| POST | `/accounting/receivables/:id/void` | `receivablesController.voidReceivable` | session (`receivables.manage`) | Void a receivable | Redirect |
| GET | `/accounting/banks` | `bankReconciliationController.page` | session (`bank.reconcile`) | Company bank accounts | HTML |
| POST | `/accounting/banks` | `bankReconciliationController.addBank` | session (`bank.reconcile`) | Add a bank account | Redirect |
| POST | `/accounting/banks/:id/reconciliations` | `bankReconciliationController.start` | session (`bank.reconcile`) | Start a reconciliation | Redirect |
| GET | `/accounting/reconciliations/:id` | `reconciliationController.show` | session (`bank.reconcile`) | One reconciliation | HTML |
| POST | `/accounting/reconciliations/:id` | `reconciliationController.save` | session (`bank.reconcile`) | Save it | Redirect |
| GET | `/accounting/budgets` | `budgetsController.page` | session (`accounting.view`) | Budgets | HTML |
| POST | `/accounting/budgets` | `budgetsController.save` | session (`budgets.manage`) | Save a budget | Redirect |
| GET | `/accounting/sales` | `salesImportsController.page` | session (`accounting.view`) | **CRM Sales**: sales received from CRM and how each was posted | HTML |

### 2.8 Reports, analytics, settings

The 19 reports are registered in a loop (`routes/reports.js`), two routes each (page and export), so they are shown
as two pattern rows. `:key` is one of: `employee-masterlist`, `payroll-register`, `monthly-payroll`,
`payroll-expense`, `employee-compensation`, `deduction-summary`, `attendance-summary`, `daily-time-records`,
`overtime-summary`, `leave-summary`, `bank-enrollment-summary` (these need `reports.view`), and `expense-report`,
`income-report`, `income-statement`, `balance-sheet`, `cash-flow`, `trial-balance`, `general-ledger`,
`financial-analytics` (these need `reports.financial`).

| Method | URL path | Controller / function | Auth | What it does | Returns |
|---|---|---|---|---|---|
| GET | `/reports` | `reportCatalogController.catalog` | session (`reports.view` or `reports.financial`) | List of reports | HTML |
| GET | `/reports/:key` (19 routes) | `<report>Controller.page` | session (report's permission) | Shows one report | HTML |
| GET | `/reports/:key/export` (19 routes) | `<report>Controller.exportFile` | session (report's permission) | Downloads one report | XLSX or PDF |
| GET | `/analytics` | `analyticsController.page` | session (`analytics.view`) | Data analytics dashboard | HTML |
| GET | `/settings` | `systemSettingsController.page` | session (`settings.manage`) | System settings | HTML |
| POST | `/settings` | `systemSettingsController.save` | session (`settings.manage`) | Save settings | Redirect |
| GET | `/settings/roles` | `rolesPermissionsController.page` | session (`roles.manage`) | Roles and permissions | HTML |
| POST | `/settings/roles` | `rolesPermissionsController.save` | session (`roles.manage`) | Save grants | Redirect |
| GET | `/settings/announcements` | `announcementsController.page` | session (`settings.manage`) | Announcements | HTML |
| POST | `/settings/announcements` | `announcementsController.publish` | session (`settings.manage`) | Publish one | Redirect |
| POST | `/settings/announcements/:id/withdraw` | `announcementsController.withdraw` | session (`settings.manage`) | Withdraw one | Redirect |
| GET | `/settings/security` | `securityMonitorController.page` | session (`audit.view`) | Security monitor | HTML |
| GET | `/settings/security/sign-ins` | `signInHistoryController.page` | session (`audit.view`) | Sign-in history | HTML |
| POST | `/settings/security/verify-audit` | `securityMonitorController.verifyAudit` | session (`audit.view`) | Check the sealed audit chain | Redirect |
| GET | `/settings/integration` | `integrationController.page` | session (`integration.manage`, Accounting Supervisor) | **Integration page**: tokens, events in and out, retries | HTML |
| POST | `/settings/integration/tokens` | `integrationController.createToken` | session (`integration.manage`) | Create a service token for HR, CRM or Inventory (shown once) | Redirect |
| POST | `/settings/integration/tokens/:id/revoke` | `integrationController.revokeToken` | session (`integration.manage`) | Revoke a token | Redirect |
| POST | `/settings/integration/inbox/:id/retry` | `integrationController.retryIn` | session (`integration.manage`) | Re-apply a failed received event | Redirect |
| POST | `/settings/integration/outbox/:id/retry` | `integrationController.retryOut` | session (`integration.manage`) | Try sending a queued event again | Redirect |
| GET | `/settings/backup` | `backupController.page` | session (`settings.manage`) | Backups | HTML |
| POST | `/settings/backup` | `backupController.create` | session (`settings.manage`) | Make a backup now | Redirect |
| POST | `/settings/backup/cleanup` | `backupController.cleanup` | session (`settings.manage`) | Run the retention clean-up | Redirect |
| GET | `/settings/backup/:name/download` | `backupController.download` | session (`settings.manage`) | Download a backup | file (.sql.gz) |
| POST | `/settings/backup/:name/delete` | `backupController.remove` | session (`settings.manage`) | Delete a backup | Redirect |

---

## 3. Integration endpoints compared with the CRM contract (v0.4.1)

What the contract expects from the **Accounting** team, and what JVzPay has **after the alignment of 2026-11-14**.

| Contract item | Exists in my code? | My actual path or name if different | Notes |
|---|---|---|---|
| §2 HMAC-signed requests **received** (`X-JVZ-Client`, `X-JVZ-Timestamp`, `X-JVZ-Signature`) | **Yes** | `lib/serviceSignature.js`, `authenticateRequest()` in `services/integrationService.js` | Exactly the contract's formula; `path` = path + query string as sent; body = raw bytes. The secret per sender is in JVzPay's `.env`: `CRM_INBOUND_SECRET` (CRM's `JVZ_SECRET_ACCOUNTING`). A secret is valid only for its own `X-JVZ-Client`. The older bearer token is still accepted as a second option. |
| §2 Clock skew (5 min) and replay refusal | **Yes** | – | `401 {"error":"stale_timestamp"}` beyond 5 minutes either way; `401 {"error":"replayed_request"}` for a signature already accepted. The replay memory is held in the app process (it is reset when JVzPay restarts; the 5-minute window still applies). |
| §2 Error codes `unauthorized` / `invalid_signature` / `stale_timestamp` / `replayed_request` | **Yes** | – | For signed requests. Bearer requests keep `{"status":"unauthorized","error":"…"}`. |
| §2 HMAC signing of requests JVzPay **sends** | **Yes** | `callApp()` in `services/integrationService.js` | When `CRM_API_SECRET` (CRM's `JVZ_CRM_INBOUND_SECRET_ACCOUNTING`) is set; every attempt is signed anew with a `+08:00` timestamp. JVzPay sends nothing to CRM today, so this matters only if that changes. |
| §4 CRM posts events to `POST /api/integration/v1/events` | **Yes** | also `POST /api/v1/events` | Answers to a signed caller: `202 {"status":"accepted","event_id","processing":"processed"|"failed","error"?}`, `200 {"status":"duplicate","event_id"}`, `400 {"error":"invalid_envelope","details":[…]}`, `401 {"error":…}`. A stored event that could not be applied is still `202` (as in contract §5); the failure is visible with `GET /events/{event_id}` and on JVzPay's Integration page. |
| §3 Event envelope | **Yes** | – | Required: `event_id` (≤ 64 chars), `event_type`, `source` (= `X-JVZ-Client`), `data`. `schema_version` must be `1` (others: `400`). JVzPay's own envelopes use `source: "johnvivz_accounting"` and `occurred_at` in `+08:00`. |
| §3 Consumers ignore duplicates by `event_id` | **Yes** | table `integration_inbox` | `event_id` UNIQUE and `idempotency_key` UNIQUE (across all senders, a little stricter than CRM's per-sender rule). |
| §3 Money as decimal strings, quantities as numbers (e.g. 1.5 kg) | **Yes** | – | Read exactly in centavos. |
| §4 `SaleCompleted` (CRM → Accounting) | **Yes** | `services/crmSaleMapping.js` → handler `saleCompleted` | Reads `sale_id`, `order_id`, `transaction_no`, `customer_id`, `completed_at`, `items[…is_vatable]`, `discounts`, `totals`, `payments`, `payment_status`, `currency`. Checks that `totals.gross` = items, `totals.net` = gross − discount_total, each `line_total` = qty × price − discount. `payment_status` `paid` → Cash; `on_account` (no payments) → Accounts Receivable for the CRM `customer_id`. Not supported yet: a sale that is part paid and part on account. |
| §0 / Q2 "Accounting computes VAT" from `is_vatable` | **Yes** | `inclusiveVat()` | 12% included in the price: Output VAT = vatable amount after discounts × 12/112; an order-level discount is spread over the lines first. Example: ₱112 vatable + ₱170 non-vatable → VAT ₱12.00. |
| §4 `SaleCancelled` | **Yes** | handler `saleCancelled` | `sale_id: null` (cancelled before completion) → accepted, nothing posted. With a `sale_id` JVzPay has → its entry is reversed. |
| §4 `RefundRecorded` | **Yes** | handler `refundRecorded` | Reads `refund_id`, `sale_id`, `amount`, `reason`, `recorded_at`; also reverses the refund's share of Output VAT. Paid sales only. `return_items` and `approved_by_employee_id` are kept in the stored event but not used for posting (stock is Inventory's). |
| §4 `PaymentRecorded` | No (not needed) | – | The contract says it is not published. |
| §4 `OrderConfirmed` | No (not needed) | – | Sent to Inventory only; JVzPay answers 400 if it ever receives it. |
| §4 retry rules (`202`/`200` delivered, `400` dead, others retried) | **Yes** | – | JVzPay never answers 422 to a signed caller, so CRM never needs to resend a stored event. |
| §5 Accounting → CRM events ("none yet") | **Yes (none sent)** | – | JVzPay never queues anything for target `crm`. |
| §6 CRM calls `GET /api/integration/v1/health` | **Yes** | also `/api/v1/health` | Signed (or bearer). Answers `200 {"status":"ok","app":"johnvivz_accounting","source":"johnvivz_crm","as_of":…}`. |
| §7 Accounting reads CRM (`/customers`, `/orders`, `/sales`, `/reconciliation/sales`) | **No** | – | Not needed by JVzPay today. If it ever is, `callApp("crm", …)` already signs such calls. |
| §8 / Q8 Confirmation that a sale was **posted** | **Partly** | `GET /api/integration/v1/crm/sales/{sale_id}`, `GET /api/integration/v1/events/{event_id}` | No `SalePosted` event is pushed (CRM would refuse it: the contract allows no events from Accounting yet). CRM can **pull**: `status` (`posted`, `cancelled`, `partially_refunded`, `refunded`), `tax_amount`, `journal_entry.entry_no`. Now keyed by CRM's `sale_id`. |
| §5.1 `EmployeeRequestSubmitted` / §4 `EmployeeRequestDecided` (ESS approvals, DRAFT) | **No (different design)** | JVzPay → **HR**: `LeaveRequested`, `OvertimeRequested`, `AttendanceCorrectionRequested`, `LeaveConversionRequested`; HR → JVzPay: `RequestDecided` | ESS lives **inside JVzPay**. JVzPay sends requests to **HR**, and accepts `RequestDecided` only from HR. Field and value differences: `request_no` (not `request_id`), `work_date` (not `date`), extra type `leave_conversion`, decisions `approved`/`rejected` only (no `returned`), no `replaces_request_id`. This draft needs a three-team decision (HR, CRM, Accounting) and was not changed. |
| Q6 Identity / logins | **Yes (team decision 2026-11-16)** | `POST /api/integration/v1/auth/login` | CRM creates a deactivated account from HR's list and activates it on the first successful department login (signed with `CRM_INBOUND_SECRET`). Answer fields and errors: see the 2026-11-16 update at the top and `docs/API_INTEGRATION.md` §3.1. Returns no salary, bank or ID data. |
| Extra read API for CRM (not in contract) | **Extra** | `GET …/crm/receivables`, `GET …/crm/customers/{customer_id}/balance` | Credit-sale balances, matched by CRM's `customer_id`. |

---

## 4. Security for calls between apps

- **HMAC signing (X-JVZ-Client / X-JVZ-Timestamp / X-JVZ-Signature): both directions.**
  - Receiving: verified on every service endpoint when the headers are present (secret from `{APP}_INBOUND_SECRET`).
  - Sending: added to every outgoing call when `{APP}_API_SECRET` is set; re-signed on each retry.
- **Duplicate protection (event_id): yes, for received events.** `integration_inbox` has UNIQUE keys on `event_id`
  and on `idempotency_key`. A repeat gets `200 {"status":"duplicate"}` and is not applied again (also logged).
  Events JVzPay sends carry a new UUID `event_id`, `idempotency_key = "<type>:<entity>:<event_id>"`, and an
  `Idempotency-Key` header.
- **Replay / timestamp protection: yes for signed requests** (5-minute window, each signature accepted once). Bearer
  tokens have no replay protection; they can be revoked on `/settings/integration`.
- **Other auth still accepted:** the bearer service token (`Authorization: Bearer jvz_…`), created once per app by the
  Accounting Supervisor on `/settings/integration` (only its SHA-256 hash is stored). No JWT. No CORS settings (not
  needed for server-to-server calls).
- **Which app may call what:** each read-API group (`/hr`, `/crm`, `/inventory`) answers only its own app (`403`
  otherwise); each app may send only its own event types (`400` otherwise).
- **Transport:** plain HTTP on the Wi-Fi unless `HTTPS_CERT_FILE`/`HTTPS_KEY_FILE` are set. Signed requests never
  send the secret itself, but the event data travels unencrypted on the local network during the test.
- **Rate limits:** 600 requests/min on the API, and 60 per 15 min on `/auth/login`.

---

## 5. Events and calls to OTHER apps

### 5.1 What JVzPay SENDS

How sending works: events are written to table `integration_outbox` inside the same database transaction as the
business change. The background job runs every minute and sends due events as
**`POST {TARGET}_API_URL + {TARGET}_API_PREFIX + /events`** (prefix default `/api/v1`), with signed `X-JVZ-*`
headers when `{TARGET}_API_SECRET` is set (signed anew on every attempt) and/or `Authorization: Bearer
{TARGET}_API_TOKEN`, an `Idempotency-Key` header, a JSON envelope (contract §3 format, `source:
"johnvivz_accounting"`, `occurred_at` in `+08:00`) and a 10-second timeout. Any `2xx` answer counts as delivered;
`400` stops at once (`failed`, as in contract §4). Other failures retry after 1, 2, 4 … minutes (at most 60) and give
up after **10 attempts** (status `failed`, retry by hand on the Integration page). If the target URL is empty, the
event waits as `not_connected` and is checked again every 15 minutes. Other apps can also **pull** the same events
with `GET /api/v1/feed`.

| Target | Method + URL | Event / call | When | Data fields |
|---|---|---|---|---|
| HR | POST `{HR_API_URL}{HR_API_PREFIX}/events` | `LeaveRequested` | Employee files leave and the first approver must be reached through HR | `request_type`, `request_no`, `employee_id` (HR id), `employee_no`, `employee_name`, `department_code`, `position_title`, `leave_type`, `leave_type_name`, `start_date`, `end_date`, `days`, `reason` |
| HR | same | `OvertimeRequested` | Same, for overtime | common fields above + `work_date`, `start_time`, `end_time`, `hours`, `ot_type`, `reason` |
| HR | same | `AttendanceCorrectionRequested` | Same, for an attendance correction | common fields + `work_date`, `requested_status`, `requested_time_in`, `requested_time_out`, `reason` |
| HR | same | `LeaveConversionRequested` | Same, for converting leave to cash | common fields + `year`, `days`, `amount` |
| HR | same | `LeaveRecorded` / `LeaveRejected`, `OvertimeRecorded` / `OvertimeRejected`, `AttendanceCorrected` / `AttendanceCorrectionRejected`, `LeaveConversionRecorded` / `LeaveConversionRejected` | Every **final** decision in JVzPay | `request_no`, `employee_id`, `decision`, `decided_by` (name), plus: leave → `start_date`, `end_date`, `days`; conversion → `year`, `days`, `amount`; overtime → `work_date`, `start_time`, `end_time`, `hours`, `ot_type`; correction → `work_date`, `status`, `time_in`, `time_out` |
| HR | same | `EmployeeAccountActivated` | A new hire registered in ESS | `employee_id`, `employee_no`, `email`, `department_code`, `position_title`, `activated_at` |
| HR | same | `DependentEnrolled` / `BenefitEnrolled` | Payroll Staff verified a dependent / benefit enrollment | dependent: `employee_id`, `request_no`, `full_name`, `relationship`, `birth_date`. Benefit: `employee_id`, `request_no`, `benefit_type`, `plan_name`, `coverage_amount`, `dependents_count`, `covered_dependents[{request_no, full_name, relationship}]`, `beneficiaries[{full_name, relationship, birth_date, share_percent}]` |
| HR | POST `{HR_API_URL}{HR_API_PREFIX}/employees/verify` (direct call, not an event; signed/token like events) | ESS registration check | Only when `HR_API_URL` is set; otherwise JVzPay compares with the HR snapshot it already holds | `employee_id` (employee no.), `full_name`, `email`, `department`, `position`, `verification_reference`. Expects `{match, eligible}` |
| CRM | – | **nothing** | – | No event or call to CRM exists in the code, as the contract expects ("Accounting: none yet"). |
| Inventory | – | **nothing** | – | No event or call to Inventory exists in the code. |

`PayrollApproved`, `PayslipPublished`, `PayrollPaymentRecorded` and `JournalPosted` are **not sent**. They used to be
listed in `docs/API_INTEGRATION.md` §3; that document now marks them "planned only, no code".

### 5.2 What JVzPay RECEIVES (all on `POST /api/integration/v1/events` or `/api/v1/events`, signed or with a bearer token)

| Source | Event | Data fields JVzPay requires (optional in brackets) | What JVzPay does |
|---|---|---|---|
| CRM | `SaleCompleted` | **Contract shape:** `sale_id`, `completed_at`, `items[{quantity, unit_price, discount_amount, line_total, is_vatable}]`, `totals{gross, discount_total, net}`, `payment_status` [`order_id`, `transaction_no`, `customer_id`, `discounts`, `payments[{method, amount, …}]`, `currency` = PHP]. The older JVzPay shape (`transaction_id`, `lines`, `total_amount`) still works. | Posts a journal entry: Dr Cash (1010) or Accounts Receivable (1100) for `totals.net`, Dr Sales Discounts (4030) / Cr Sales Revenue (4010, net of VAT), Cr Output VAT (2300, **computed by JVzPay**: vatable amount × 12/112). Creates a receivable if on account. Saves a row in `sales_imports` keyed by `sale_id`. Refuses a `sale_id` it already has. |
| CRM | `SaleCancelled` | Contract shape: `order_id`, `sale_id` (null before completion) [`reason`, `cancelled_at`] | `sale_id` null: processed, nothing posted. Otherwise reverses the sale's entry and voids its receivable (only if nothing was collected yet). |
| CRM | `RefundRecorded` | Contract shape: `sale_id`, `amount`, `recorded_at` [`refund_id`, `reason`, `order_id`, `return_items`, `approved_by_employee_id`] | Posts Dr Sales Returns (4030) + Dr Output VAT (2300, the refund's share) / Cr Cash (1010). Paid sales only, up to the amount not yet refunded. |
| HR | `EmployeeCreated`, `EmployeeUpdated` | `employee_id`, `employee_no`, `first_name`, `last_name`, `department_code`, `position_title`, `date_hired` [`middle_name`, `suffix`, `birth_date`, `email`, `phone`, `department_name`, `employment_type`, `employment_status`, `verification_reference`, `supervisor_employee_id`] | Creates or updates JVzPay's read-only employee snapshot (and department/position). |
| HR | `EmployeeStatusChanged` | `employee_id`, `employment_status`, `effective_date` [`separation_date`] | Updates status; payroll stops after separation. |
| HR | `EmployeeCompensationApproved` | `employee_id`, `basic_salary`, `rate_basis`, `effective_date` [`pay_frequency`, `allowances[{code, amount}]`, `approval_reference`, `compensation_version_id`] | Records the approved salary (must be inside the position's salary band) and HR allowances. |
| HR | `DepartmentUpserted` | `department_code` [`department_name`, `is_active`] | Saves the department. |
| HR | `PositionUpserted` | `department_code`, `position_title` [`is_active`] | Saves the position. |
| HR | `RequestDecided` | `request_type`, `request_no`, `decision` (`approved`/`rejected`), `approver_name` [`approver_employee_id`, `remarks` (required when rejecting)] | Records the supervisor's first approval; an approval moves the request to Accounting/Payroll for the final decision. |
| HR | `ScheduleDaysPlotted` | `employee_id`, `days[…]` (max 62; times HH:MM, or `day_off`, or `clear`) | Saves each employee's daily schedule. |
| Inventory | `PurchaseOrderApproved`, `GoodsReceived`, `SupplierInvoiceReceived`, `StockAdjusted`, `InventoryValuationReported` | see `docs/API_INTEGRATION.md` §2.3 | Purchase references, three-way-matched payables, stock adjustment postings, valuation check. |

Any other event type from a given app is refused with `400`.

### 5.3 Connections to apps other than CRM

- **HR ↔ Accounting/Payroll** is the main link: HR is the source of employees, salaries, departments, positions
  and schedules. JVzPay sends HR every ESS request that needs a department supervisor, and every final decision.
  HR also has its own read API (`…/hr/*`) and a department login (`…/auth/login`). HR and Inventory can use the
  same signed requests as CRM (`HR_INBOUND_SECRET`, `INVENTORY_INBOUND_SECRET`) or keep their bearer tokens.
- **Inventory → Accounting**: purchase orders, goods receipts, supplier invoices, stock adjustments, valuation
  (receive only). Inventory read API: `…/inventory/*`.
- **Department login for every app**: CRM, Inventory and HR employees register in JVzPay ESS, and their own app
  checks their password with `POST …/auth/login`.

(`…` = `/api/integration/v1` or `/api/v1`; both work.)

### 5.4 Direct access to another team's database

**None found.** JVzPay opens one Sequelize connection to its own database (`DB_NAME`, default `JVzPay`).
`migrate.js` connects to the MySQL server but only creates and uses `DB_NAME`. No reference to
`johnvivz_hr_db`, `johnvivz_accounting_db`, `johnvivz_inventory_db` or any CRM database exists in the code.

---

## 6. Configuration

### 6.1 Every `.env` variable the app reads (names and purpose only)

| Name | Purpose |
|---|---|
| `NODE_ENV` | `development` or `production` (production turns on secure cookies and trusts one proxy) |
| `PORT` | Web server port (default 3002) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | MySQL connection (defaults: localhost, 3306, JVzPay, root, empty) |
| `SESSION_SECRET` | **Secret.** Signs the browser session cookie (required) |
| `DATA_ENCRYPTION_KEY` | **Secret.** 64-hex-character key that encrypts bank and government ID numbers (required; losing it makes that data unreadable) |
| `AUDIT_SEAL_KEY` | **Secret, optional.** Separate key for sealing the audit trail |
| `SESSION_IDLE_MINUTES` | Sign-out after this many idle minutes |
| `MAX_FAILED_LOGINS`, `LOCKOUT_MINUTES` | Account lock after wrong passwords, and for how long |
| `RESET_LINK_MINUTES` | Lifetime of one-time password reset links |
| `HOST` | Listen address: empty on a laptop (every address), `127.0.0.1` on the AWS server behind Nginx |
| `PUBLIC_BASE_URL` | Public address (`https://johnvivz-pay.duckdns.org` on AWS); password reset and registration links start with it |
| `TRUST_PROXY` | `1` behind Nginx (client IPs and https from `X-Forwarded-For` / `X-Forwarded-Proto`); default `false` |
| `COOKIE_SECURE` | `true` once https works on the server; default `false` so http sign-in works on a laptop |
| `PENDING_INTEGRATIONS` | Production only: apps whose server is not ready yet (`hr,crm,inventory`), not required at start-up |
| `CRM_EVENTS_ENABLED`, `INVENTORY_EVENTS_ENABLED` | Queue events for that app (default `true`; `HR_EVENTS_ENABLED` defaults to `false`) |
| `HTTPS_CERT_FILE`, `HTTPS_KEY_FILE` | PEM files to serve HTTPS directly (empty = HTTP). **Empty on AWS**: Nginx does TLS |
| `HTTP_REDIRECT_PORT` | With HTTPS on, extra port that redirects HTTP to HTTPS (0 = off) |
| `DISABLE_SCHEDULER` | `1` turns off background jobs, **including sending integration events** |
| `COMPANY_NAME`, `COMPANY_ADDRESS` | Printed on payslips and reports |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | First Accounting Supervisor account created by `npm run seed` (**password is secret**) |
| `HR_INBOUND_SECRET`, `CRM_INBOUND_SECRET`, `INVENTORY_INBOUND_SECRET` | **Secret.** Shared secret each app uses to sign its calls **to** JVzPay (CRM's name for it: `JVZ_SECRET_ACCOUNTING`). Empty = that app can only use a bearer token. |
| `HR_API_URL`, `CRM_API_URL`, `INVENTORY_API_URL` | Base address of each other app, **without** the API path (empty = not connected) |
| `HR_API_PREFIX`, `CRM_API_PREFIX`, `INVENTORY_API_PREFIX` | API path of each other app (default `/api/v1`; CRM: `/api/integration/v1`) |
| `HR_API_SECRET`, `CRM_API_SECRET`, `INVENTORY_API_SECRET` | **Secret.** Shared secret JVzPay uses to sign its calls **to** that app (CRM's name: `JVZ_CRM_INBOUND_SECRET_ACCOUNTING`) |
| `HR_API_TOKEN`, `CRM_API_TOKEN`, `INVENTORY_API_TOKEN` | **Secret.** Bearer token that app gave JVzPay (alternative to the secret) |
| `UPLOAD_DIR` | Optional folder for uploaded documents (default `storage/uploads`) |
| `BACKUP_DIR` | Optional folder for backups (default `storage/backups`) |
| `MYSQL_PATH`, `MYSQLDUMP_PATH` | Optional paths to the MySQL command-line tools (for backup/restore) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Optional outgoing email (**`SMTP_PASS` is secret**). Note: the `nodemailer` package is **not** in `package.json`, so email will not work until it is installed. |
| `XIAN_ELECTRON` | Set by an Electron wrapper so `index.js` does not auto-start the server |
| `E2E_PORT`, `E2E_BROWSER` | Automated end-to-end tests only |

### 6.2 Where the other apps' base URLs are configured

Only in **`.env`**: `{APP}_API_URL` and `{APP}_API_PREFIX` (plus `{APP}_API_SECRET` / `{APP}_API_TOKEN`), read by
`targetConfig()` in `services/integrationService.js`. They are not stored in the database or on a settings page.
JVzPay must be **restarted** after changing them. On the developer's laptop they are currently **empty**. For the
Wi-Fi test, CRM's values would be `CRM_API_URL=http://<CRM-laptop-IP>:<CRM-port>` and
`CRM_API_PREFIX=/api/integration/v1`, but JVzPay sends nothing to CRM today, so they are optional.

**What the CRM developer needs from JVzPay for the test:** JVzPay's address (`http://<JVzPay-laptop-IP>:3002`,
API path `/api/integration/v1`) and the shared secret that goes in JVzPay's `CRM_INBOUND_SECRET` and CRM's
`JVZ_SECRET_ACCOUNTING` (handed over privately, never in chat logs or git). A bearer token from
**System → Integration** (`/settings/integration`) also still works.

---

## 7. Team-specific questions: Accounting

**How are sales and refunds recorded?**
- **From CRM (automatic):** a `SaleCompleted` event becomes a posted journal entry right away, plus a
  `sales_imports` row keyed by CRM's `sale_id` (and an account receivable for `on_account` sales). `SaleCancelled`
  reverses that entry (or posts nothing if the order never became a sale). `RefundRecorded` posts Dr Sales Returns and
  Discounts (4030) + Dr Output VAT (2300, the refund's share) / Cr Cash on Hand (1010). Nothing is deleted;
  everything is a new entry or a reversal. Results are listed on **Accounting › CRM Sales** (`/accounting/sales`).
- **By hand:** Accounting Staff can record other income on `/accounting/income` and on-account sales on
  `/accounting/receivables`. Income recorded by Accounting Staff (`accounting.prepare`) waits for approval;
  the Accounting Supervisor (`accounting.manage`) posts at once.

**Who computes VAT?**
- **Accounting (JVzPay) does**, as the contract decided. For each contract-shaped sale: Output VAT = the `is_vatable`
  lines' amount after discounts × 12/112 (prices include 12% VAT; an order-level discount is spread over the lines
  first). It is posted to 2300 Output VAT Payable, and Sales Revenue is credited net of VAT. A refund reverses its
  share of that VAT. (The older JVzPay event shape still uses the `tax` the sender gives.)

**Is there anything that confirms a sale was "posted"?**
- **Yes, by pulling. No push event** (the contract allows no events from Accounting to CRM yet).
  - The `202` answer says `"processing":"processed"` only after the journal entry was saved in the same
    transaction; `"processing":"failed"` (with `error`) means it was stored but **not** posted.
  - `GET /api/integration/v1/events/{event_id}` gives the stored status (`processed` / `failed` + error, `result_ref`
    such as "sale TXN-0001 (…) posted as JE-…").
  - `GET /api/integration/v1/crm/sales/{sale_id}` returns `status` (`posted`, `cancelled`, `partially_refunded`,
    `refunded`), `tax_amount` and `journal_entry.entry_no`.

**ESS note (ESS lives in this app):** employees file leave (`/my/leave`), overtime (`/my/overtime`) and attendance
corrections (`/my/attendance`) in JVzPay. Each request needs two approvals: first the immediate supervisor (in
JVzPay if they have an account, otherwise **through HR** via the `…Requested` events and `RequestDecided`), then the
final decision by Accounting/Payroll. The employee sees the result on the same ESS page and in notifications. JVzPay
stores salary, bank account and government ID numbers (bank and ID numbers encrypted). **None of these are sent to
CRM.** The department login answer contains only name, email, ids, department, position and employment status.

---

## 8. What is missing or blocking (Accounting team to-do before the connection test)

Done on 2026-11-14: HMAC in both directions, the `/api/integration/v1` path, contract-shaped `SaleCompleted` /
`SaleCancelled` / `RefundRecorded`, VAT by Accounting (refunds included), contract status codes for signed callers,
`400` stops retries, `schema_version` check, health check, port 3002 everywhere, migrations no longer git-ignored,
documentation corrected.

**Test results (2026-11-14, on a throwaway `JVzPay_test` database):**
- Unit tests: all pass, including 7 new contract tests (`tests/integrationContract.test.js`: signature formula,
  query string signed, stale/replayed/wrong-sender refused, VAT 12/112, order-level discounts, refund VAT, mapping errors).
- HTTP end-to-end tests: **644 of 647 checks pass**. Stage 17 (finance) passes 42/42, including **15 new checks**
  that send real signed requests to `/api/integration/v1`: health, replay, wrong secret, stale timestamp, bearer still
  working, contract `SaleCompleted` posted as Dr Cash 282 + Dr Discounts 10 / Cr Sales 280 + Cr Output VAT 12,
  duplicate = 200, `schema_version` 2 = 400, refund reversing ₱2.38 of VAT, cancel before completion, a bad sale
  stored as `202` + `failed`, and `GET …/crm/sales/{sale_id}`.
- **Known failures, not related to the CRM integration:** stage 14 (3 checks) and stage 19 (stops early). Both come
  from the position salary-band rule (migrations 023–025): the test positions have no salary band, so HR's
  `EmployeeCompensationApproved` is refused, and payroll then refuses an employee with no approved salary. These test
  stages need salary bands added; the CRM connection does not depend on them.

Still to do, in order of importance:

1. [x] **Commit `database/migrations/`**: 001–025 committed on branch `integration-alignment` (2026-11-16). Migration 026 is new: review its SQL, then `npm run migrate`.
2. [ ] **Exchange the secret with CRM** for the test: generate one (`openssl rand -hex 32`), put it in JVzPay's
       `CRM_INBOUND_SECRET` and CRM's `JVZ_SECRET_ACCOUNTING`, restart JVzPay. Hand it over privately.
3. [x] **Confirmed by CRM (2026-11-16):** prices include 12% VAT, and `payment_status` is always `paid` (an order is
       completed only after payment is verified). JVzPay now refuses any other value for CRM's contract-shaped sales.
4. [ ] **Employee request approvals (§5.1 draft):** agree with HR and CRM how CRM approvals fit the ESS → HR flow
       (`request_no` vs `request_id`, `returned`, `replaces_request_id`). Not changed in JVzPay yet.
5. [ ] **Test-session setup:** allow port 3002 in Windows Firewall, keep the scheduler on (`DISABLE_SCHEDULER` not `1`).
6. [ ] **Fix the salary-band test data** in e2e stages 14 and 19 (see "Known failures" above).
7. [ ] **Optional:** add `nodemailer` to `package.json` if email is needed; pin the Node version
       (`"engines": {"node": ">=20"}`).

**Connection test with CRM, step by step:**
1. JVzPay laptop: put the shared secret in `.env` as `CRM_INBOUND_SECRET`, run `npm start`, note the address it
   prints (e.g. `http://192.168.x.x:3002`).
2. CRM laptop: set JVzPay's base address + `/api/integration/v1` and the same secret as `JVZ_SECRET_ACCOUNTING`,
   switch `INTEGRATION_ACCOUNTING_MODE` to `live`.
3. CRM "Test connection" → `GET /api/integration/v1/health` must answer `200 {"status":"ok"}`.
4. Complete a sale in CRM → JVzPay answers `202 accepted, processing: processed`; the sale appears on
   **Accounting › CRM Sales** (`/accounting/sales`) with its Output VAT; `GET /api/integration/v1/crm/sales/{sale_id}`
   shows `status: posted`.
5. If `processing: failed`: the reason is in `GET /api/integration/v1/events/{event_id}` and on JVzPay's
   **System › Integration** page, where it can be retried after the cause is fixed.
