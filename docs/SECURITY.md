# JVzPay security and privacy controls

For the store owner, the Super Admin and the developers. Status as of 2026-11-10.

**Legend:** ✅ in place · 🆕 added on 2026-11-10 · 👤 needs a person or a decision, not code · ➖ does not apply to JVzPay · ⏸ not needed, by the owner's decision (2026-11-10)

| # | Control | Status | How JVzPay does it |
|---|---|---|---|
| 1 | Role-based access control | ✅ | Five roles; every route checks permissions on the server (`middleware/auth.js`, `config/permissions.js`); Roles & Permissions page refuses grants that would let one role approve its own work. |
| 2 | Password hashing | ✅ | bcrypt, cost 12. |
| 3 | Strong password policy | ✅ | At least 10 characters, letters and numbers, not containing the email name (`lib/validate.js`). |
| 4 | Login attempt limit / lockout | 🆕 | Account locks for 15 minutes after **3** wrong passwords (was 5). `MAX_FAILED_LOGINS`, `LOCKOUT_MINUTES` in `.env`. |
| 5 | Auto-logout on inactivity | ✅ | Sessions end after 30 minutes without activity (`SESSION_IDLE_MINUTES`) and after 12 hours in any case. |
| 6 | Session-expiry warning | 🆕 | Two minutes before the sign-out a dialog offers "Stay signed in"; when time is up the browser signs out and the sign-in page says why. Works across tabs. |
| 7 | Token-based authentication (Laravel Sanctum) | ➖ | Sanctum is part of Laravel; JVzPay is built on XianFire/Express. Browser sign-in uses secure server sessions with CSRF protection, which is what Sanctum also uses for browser apps. API tokens would be added only if JVzPay ever exposes an API (for example to the HR system). |
| 8 | Password reset with expiring links | 🆕 | Super Admin → User Accounts → Create password reset link. Works once, expires in 30 minutes (`RESET_LINK_MINUTES`), only its hash is stored. There is no email service yet, so the Super Admin passes the link on. |
| 9 | HTTPS/SSL | 🆕 ⏸ | The app can serve HTTPS itself (`HTTPS_CERT_FILE`, `HTTPS_KEY_FILE`, optional `HTTP_REDIRECT_PORT`) or sit behind Apache/nginx with TLS. Cookies become Secure and HSTS applies. The owner decided a certificate is not needed for now, so these settings stay empty and the app serves plain HTTP. The support stays in the code and can be switched on later without changes. |
| 10 | Database field encryption | ✅ | AES-256-GCM for bank account numbers, government IDs and the HR code (`lib/crypto.js`). |
| 11 | Data masking | ✅ | Bank and ID numbers are shown as `•••• 1234`; revealing a full bank number is limited and audited. |
| 12 | Data minimization | ✅ 🆕 | Only payroll-relevant fields are kept. New: an account request's HR code is erased after the decision, an approved request's password hash is erased immediately, a rejected one after 30 days. |
| 13 | Secure file uploads | ✅ | PDF/JPG/PNG checked by file signature, 5 MB limit, stored outside the public folder, served only to the owner or an authorised reviewer. |
| 14 | Audit trail | ✅ | Every sensitive action, with who, when, what changed and why (`audit_logs`). |
| 15 | Login and logout history | 🆕 | Security Monitor → Sign-in history: sign-ins, sign-outs, failed attempts, lockouts and password events, with IP and browser. |
| 16 | Report export and print logging | ✅ 🆕 | Exports and payslip downloads were already logged. New: printing any page (Print button or the browser's own print) is logged. |
| 17 | Tamper-proof logs | ✅ 🆕 | The database refuses edits and deletes of audit records. New: every record is sealed with an HMAC chain; Security Monitor → **Verify audit trail now** detects any change or removal, even one made directly in MySQL, and alerts the Super Admin. |
| 18 | Soft deletes | ✅ | Users, employees, departments and positions are deactivated, never removed; financial records are voided or reversed, never deleted. |
| 19 | Record history / versioning | ✅ | Salary and employment history, approval histories, journal reversals, and before/after values in the audit trail. |
| 20 | Input validation | ✅ | Every form is validated on the server; masks help typing only. |
| 21 | Approval workflow for sensitive changes | ✅ | Payroll, salary changes, pay items, adjustments, bank enrollment, leave, attendance corrections, overtime, accounting entries and account requests all need a second person. |
| 22 | SQL injection protection | ✅ | Parameterised queries only; sort columns come from fixed lists. |
| 23 | XSS protection | ✅ | Templates escape all output; strict Content-Security-Policy with no inline scripts. |
| 24 | CSRF protection | ✅ | A token on every form and script request. |
| 25 | Brute-force protection | ✅ | Sign-in rate limit (30 per 15 minutes per device) plus the account lockout; registration and reset are rate-limited too. |
| 26 | Mass assignment protection | ✅ | Each form saves only a fixed list of fields; pay terms and roles are re-checked on the server. |
| 27 | Secrets protection (.env) | ✅ 🆕 | Secrets live only in `.env`, which the web server never serves. New: `.gitignore` keeps `.env`, `storage/` and backups out of version control; `.env.example` lists the settings without values. |
| 28 | Protected API routes | ✅ | JVzPay has no public API. Its few script endpoints require a signed-in session and a CSRF token, and answer 401 when signed out. |
| 29 | Protected frontend routes (401/403) | ✅ | Signed-out visitors are sent to sign-in (401 for scripts); missing permissions show a 403 page. |
| 30 | Automatic daily backups | 🆕 | Every day at 02:00 (System Settings → Backup), or the first time the app runs after that. Keeps 14 days, never fewer than 3 backups. A failure notifies the Super Admin. |
| 31 | Disaster recovery plan | 🆕 | [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md). |
| 32 | Server monitoring and uptime alerts | 🆕 ⏸ | Security Monitor shows uptime, database response, disk space, last backup and seal status. The owner decided an outside uptime monitor is not needed, so no down-alerts are sent. `/healthz` stays available if one is connected later. |
| 33 | Secure offline sync | ➖ | JVzPay has no offline mode; every action goes to the server and is checked there. Offline payroll or accounting entries would weaken approvals and the audit trail, so it is not built. |
| 34 | Data Privacy Act (RA 10173) | ✅ 👤 | Privacy notice, acknowledgement, encryption, access control, audit, retention and breach procedure are in place. The store must still designate a DPO and keep its own privacy manual. |
| 35 | NPC compliance | 👤 | Registration of the DPO (and of the data processing system, if NPC rules require it for the store's size) is done by the store with the National Privacy Commission. |
| 36 | Data Protection Officer | 👤 | Enter the DPO's name, email and phone in System Settings → Privacy; the Privacy Notice shows them. |
| 37 | Privacy notice and consent form | ✅ 🆕 | `/privacy`. New: everyone must acknowledge the notice before using JVzPay, and again when its version changes; sign-up requires it too. Employment data is processed under the employment contract and legal obligations, so this records acknowledgement rather than asking for consent. |
| 38 | Data retention policy | 🆕 | [DATA_RETENTION.md](DATA_RETENTION.md); the time-bound parts run automatically every day. |
| 39 | Breach notification procedure | 🆕 | [BREACH_RESPONSE.md](BREACH_RESPONSE.md). |
| 40 | DOH / PhilHealth data standards | ➖ ✅ | JVzPay keeps no health records, so DOH health-data standards do not apply. PhilHealth premiums follow PhilHealth's published rate, floor and ceiling. |
