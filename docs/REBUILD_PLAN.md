# JVzPay rebuild plan: JOHNVIVZ Accounting & Payroll

For the store owner and the three co-developers (HR, CRM, Inventory). Started 2026-11-11.

Sources: *JOHNVIVZ Complete System Logic, Architecture, Process and Department Dashboards* (PDF) and the
owner's master development prompt. JVzPay is the **Accounting & Payroll** application only.

## Owner's decisions (these override the PDF where they differ)

| Topic | Decision |
|---|---|
| Roles | Exactly four: **Accounting Supervisor**, **Accounting Staff**, **Payroll Staff**, **Employee (ESS)**. There is no Super Admin; the Accounting Supervisor also manages user accounts, settings, roles and backups. |
| ESS request approvals | Leave, attendance-correction and overtime requests go to the **employee's own department supervisor**, found through HR's organization data and relayed through the integration API. The Accounting Supervisor decides for Accounting/Payroll employees. A request with no valid approver waits in an exception queue and is never approved automatically. |
| Employee accounts (2026-11-13) | HR encodes the new hire (personal email, department, position) and generates the Employee ID and unique code. The new hire registers in JVzPay with those details and a password; when everything matches HR the account is **active at once** and opens only the employee's own department: Payroll/Accounting staff use JVzPay with the role of their position, other departments sign in to their own application through JVzPay's `POST /api/v1/auth/login`. Everyone keeps JVzPay Self-Service. (Replaces the earlier email-code / manual-activation decision.) |
| Attendance, leave, overtime | **Owned by Accounting/Payroll, not HR.** JVzPay keeps the official records (encoding, validation, leave types, balances) and sends approved copies to HR. *This differs from PDF §4 and §5.4: the HR team should not build its own attendance or leave records.* |
| Employee master | Owned by **HR** (identity, department, position, status, approved salary). JVzPay keeps read-only, effective-dated snapshots with the HR id and last-synced time, and never creates its own employee master. |

## Phases

Each phase ends with the full test suite passing and a short report to the owner.

| # | Phase | Status (2026-11-13) |
|---|---|---|
| 0 | Stabilise the UI redesign | Done |
| 1 | Four roles and four dashboards | Done (migration 010) |
| 2 | Integration layer: inbox, outbox, service tokens, Integration page, API documentation | Done (migration 011) |
| 3 | Employee references from HR; payroll only on HR-synchronised records | Done (migration 011) |
| 4 | Employee account registration (owner's flow of 2026-11-13) and department sign-in API | Done (migration 012) |
| 5 | Self-Service: government enrollment, dependents and benefits, holiday calendar, verification queue | Done (migration 013) |
| 6 | Department approval routing through HR for leave, attendance corrections and overtime; Self-Service overtime applications | Done (migrations 015, 016) |
| 7 | Accounts payable, accounts receivable, bank accounts and reconciliation, budgets | Done (migration 014) |
| 8 | CRM sales, refunds and cancellations; Inventory purchase orders, receipts, supplier invoices (three-way match), stock adjustments | Done (migration 014) |
| 9 | Deliverables: ER and class diagrams, architecture, API documentation, test cases, deployment | Done (docs/) |

| 10 | Time clock (morning/afternoon in and out, two punched 15-minute breaks, one-hour lunch); weekly schedules with five work days and two days off; approved overtime on the schedule (live); 10 days of vacation leave a year with year-end cash conversion; retirement fund (10/15/20%, company match, 25-year vesting) | Done (migration 017) |
| 11 | Schedules plotted by HR day by day (ScheduleDaysPlotted), month calendar with clickable days, lost hours for exceeding breaks or lunch | Done (migration 018) |
| 12 | Fixed company benefits (Cocolife HMO; combined life and accident insurance with 2 beneficiaries), ₱90,000 bonus tax exemption, clear messages for inactive HR records | Done (migration 019) |
| 13 | Accounting/Payroll Staff approve every employee request; salary loans in Self-Service | Done (migration 020) |
| 14 | Fixed kinsenas/katapusan pay schedule, supervisor-only periods (special periods for departments or employees), one Payroll tab with automatic runs, weekend/holiday release rule, 13th-month pay | Done (migration 021) |
| 15 | Two-step approval: immediate supervisor / team leader first (Team Approvals or through HR), then Accounting/Payroll | Done (migration 022) |

Migrations 010–017 were applied to the real database on 2026-11-13, each time after a full backup (`C:\Users\Khairo\JVzPay-Backups`).

## What JVzPay cannot finish alone

The live connections need the HR, CRM and Inventory applications. JVzPay builds its side and publishes the
contract (endpoints, event envelope, authentication). The tests use a stand-in HR service. No test or stand-in
data is ever written to the real database.
