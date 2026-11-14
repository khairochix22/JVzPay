# JVzPay test cases

For the capstone panel and the developers. Every case below is automated; nothing is checked by hand.
Run `DB_NAME=JVzPay_test npm run test:e2e` (end-to-end, against a throwaway `_test` database) and `npm test`
(unit, integrity and model tests). The runner rebuilds the database, starts the real server and drives it through
HTTP and a real headless browser.

| Stage | File | What it proves |
|---|---|---|
| 03 | `03-accounts.mjs` | First sign-in, forced password change, privacy acknowledgement, the four role dashboards, Accounting Staff sign-up and approval, 3-attempt lockout |
| 04 | `04-self-service.mjs` | Employees see only their own profile, payslips and requests; masked government IDs; bank enrollment and its approval; no self-approval |
| 05 | `05-attendance-leave.mjs` | Attendance encoding and validation, corrections, leave balances and approvals, overtime |
| 06 | `06-payroll.mjs` | Payroll engine (earnings, SSS, PhilHealth, Pag-IBIG, withholding tax), batch workflow draft → review → approve → finalize → release, locking, payslip PDF, payroll journal |
| 07 | `07-accounting-reports.mjs` | Income and expenses, staff entries waiting for approval, voids as reversals, balanced adjustments only, period closing, financial statements, exports, analytics |
| 09 | `09-administration.mjs` | Settings, announcements, roles and permissions guard rails, backups, dashboards complete for every role |
| 10 | `10-route-sweep.mjs` | Every registered route: anonymous visitors reach only public pages, every POST needs a CSRF token, no role reaches another role's pages or actions, no page fails or shows a broken value |
| 10 | `10-restore.mjs` | A backup restores the database exactly |
| 12 | `12-password-change.mjs` | A changed password survives a server restart |
| 13 | `13-security.mjs` | Lockout, one-time reset links, audit-trail sealing and tamper detection, sign-in history, automatic backups and retention clean-up, privacy notice versions |
| 14 | `14-integration.mjs` | Service tokens (shown once, stored hashed, revocable), the event inbox: authentication, source binding, validation, idempotency, HR employee and compensation snapshots, failed events and retry, payroll blocked for records not from HR, the outbox |
| 15 | `15-ess-registration.mjs` | The owner's account flow: HR sends a CRM Agent → the new hire registers in JVzPay → active at once → CRM signs in through JVzPay, Inventory is refused; a Payroll/Accounting new hire gets the role of their position; wrong code, email, department, position or name is refused |
| 16 | `16-enrollments.mjs` | Government numbers (format checks, encryption, masking, applied after verification), dependents and benefits (eligibility, only verified dependents), no self-verification, holiday calendar |
| 17 | `17-finance.mjs` | Accounts payable record → approve → pay with ledger checks; three-way matching with Inventory; stock adjustments; CRM sales paid, on account, refunded and cancelled; receivable collection; bank reconciliation that must balance; budgets vs actual |
| 18 | `18-department-routing.mjs` | Leave, attendance corrections and overtime of other departments go to HR; HR's decision is applied with the usual rules and the outcome is sent back |
| 19 | `19-timekeeping-retirement.mjs` | Work schedules (two different days off, 8-hour shift), My Schedule with pending and approved overtime and the live refresh, the time clock order and punch-based attendance, 10 days of vacation leave and an approved cash conversion paid by payroll, retirement enrollment (10/15/20%), deduction and company match on a finalized payroll, voluntary withdrawal before vesting (company share forfeited), approval and payout journals |
| 20 | `20-staff-approvals-loans.mjs` | Accounting and Payroll Staff open every employee-request queue and decide leave and overtime; salary loan eligibility, the 2-month and 25% limits, one loan at a time, approval by staff, release by Payroll only, the release journal and the LOAN deduction |
| 21 | `21-two-step-approval.mjs` | The final approval waits for the immediate supervisor; Accounting Supervisor as first approver when none is on record; the team leader HR names approves first under Team Approvals; nobody gives both approvals; a first-step rejection ends the request; leave balances move only on the final approval |
| 11 | `11-browser-journeys.mjs` | The specification's user journeys in a real browser on desktop and phone, the top-bar search, sidebar, theme switch, inactivity sign-out, no console or security-policy errors |
| unit | `tests/*.test.js` | Statutory schedules, payroll arithmetic, time clock rules, vesting and the VL conversion window, analytics, database integrity triggers, one model per table |

**Integration tests (deliverable 14)** are stages 14, 15 and 17: they call JVzPay exactly as the HR, CRM and
Inventory applications will (`docs/API_INTEGRATION.md`), with their own service tokens, and check the resulting
records and journal entries.
