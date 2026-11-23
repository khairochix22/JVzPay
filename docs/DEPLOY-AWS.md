# Deploying JVzPay to AWS (EC2 + MySQL 8.4 + PM2 + Nginx + Let's Encrypt)

JVzPay is the **Accounting / Payroll + Employee Self-Service** app of JOHNVIVZ. Each of the four apps runs on its **own
EC2 instance in its own AWS account**. They talk to each other **only over HTTPS through `/api/integration/v1`**, exactly
as they do on our laptops today, just with real domain names:

| App | Address | Port behind Nginx |
|---|---|---|
| HR | https://johnvivz-hr.duckdns.org | 3001 |
| **JVzPay (this app)** | **https://johnvivz-pay.duckdns.org** | **3002** |
| CRM (already live) | https://johnvivz-crm.duckdns.org | 3003 |
| Inventory | https://johnvivz-inventory.duckdns.org | (theirs) |

```
 browser / other apps ──HTTPS 443──▶ Nginx (Let's Encrypt) ──http──▶ 127.0.0.1:3002  node index.js (PM2, 1 process)
                                     │  /api/integration/  only the 3 Elastic IPs        │
                                     │  /health            public                        └──▶ MySQL 8.4 on 127.0.0.1:3306, database JVzPay
```

This guide starts from a **brand-new Ubuntu 24.04 or 26.04 server** and ends with the app running. Type the commands
exactly as shown. Lines starting with `#` are explanations, not commands. Where you see `<…>`, put your own value.

**Contents:** 1 AWS · 2 Server basics · 3 Software · 4 MySQL · 5 Code + `.env` · 6 Database + first Accounting
Supervisor · 7 PM2 · 8 Nginx + HTTPS · 9 Encryption key and backups · 10 Integration tokens · 11 Health checks ·
12 Scheduler · 13 Updates, logs, roll back · 14 Troubleshooting · 15 Every `.env` setting

---

## 1. AWS: instance, Elastic IP, security group, domain

1. **Launch an instance** (EC2 → Instances → Launch instance):
   * Name `johnvivz-pay`, image **Ubuntu Server 24.04 LTS** (or 26.04), architecture 64-bit (x86).
   * Type **t3.small** (2 GB RAM) or bigger. A t3.micro (1 GB) works only with the swap file of step 2.
   * Key pair: create one (`johnvivz-pay.pem`) and keep it safe; you need it to log in.
   * Storage: 20 GB gp3.
2. **Elastic IP** (EC2 → Elastic IPs → Allocate → Associate with the instance). This address never changes. Give it to
   the HR, CRM and Inventory teams (they allow it in their Nginx). Write down **their three Elastic IPs** too: you need
   them in step 8.
3. **Security group** of the instance (inbound rules):

   | Type | Port | Source | Why |
   |---|---|---|---|
   | SSH | 22 | **My IP** | you, to log in |
   | HTTP | 80 | 0.0.0.0/0 | Let's Encrypt check, redirect to https |
   | HTTPS | 443 | 0.0.0.0/0 | the app |

   Do **not** open 3002 (the app) or 3306 (MySQL): they listen on 127.0.0.1 only and are reached through Nginx.
4. **Domain**: on https://www.duckdns.org, sign in, and set the IP of `johnvivz-pay` to the **Elastic IP**. Check
   from your laptop: `nslookup johnvivz-pay.duckdns.org` must show the Elastic IP.

Log in from your laptop (PowerShell or Git Bash, in the folder with the key):

```bash
ssh -i johnvivz-pay.pem ubuntu@johnvivz-pay.duckdns.org
```

## 2. Server basics

```bash
sudo apt update && sudo apt -y upgrade
# Philippine time for logs and the backup cron (the app computes Manila time itself either way)
sudo timedatectl set-timezone Asia/Manila
# the clock must be right: signed requests older than 5 minutes are refused. Must say "synchronized: yes"
timedatectl | grep -i synchronized
# 2 GB swap (needed on 1 GB instances, harmless on bigger ones)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
# folders for uploads and backups, outside the code folder (they survive a fresh clone)
sudo install -d -o ubuntu -g ubuntu -m 700 /var/lib/jvzpay /var/lib/jvzpay/uploads /var/lib/jvzpay/backups /var/backups/jvzpay
```

## 3. Software: Node.js 22 LTS, MySQL 8.4, Nginx, certbot, PM2

```bash
# build tools (needed if bcrypt has to compile), git, curl
sudo apt install -y build-essential python3 git curl ca-certificates

# Node.js 22 LTS from NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
node -v          # v22.x
npm -v

# PM2 (keeps the app running and starts it after a reboot)
sudo npm install -g pm2

# Nginx and certbot (Let's Encrypt)
sudo apt install -y nginx certbot python3-certbot-nginx
```

**MySQL 8.4.** First see which version Ubuntu offers:

```bash
apt-cache policy mysql-server | head -3
```

* It shows **8.4.x** (Ubuntu 26.04): `sudo apt install -y mysql-server`
* It shows **8.0.x** (Ubuntu 24.04): add Oracle's MySQL APT repository first. Download the current
  `mysql-apt-config_*.deb` link from https://dev.mysql.com/downloads/repo/apt/ , then:

  ```bash
  wget https://dev.mysql.com/get/mysql-apt-config_<version>_all.deb -O /tmp/mysql-apt-config.deb
  sudo dpkg -i /tmp/mysql-apt-config.deb     # choose "mysql-8.4-lts", then OK
  sudo apt update && sudo apt install -y mysql-server
  ```

  (JVzPay also runs on MySQL 8.0; everything below applies to both.)

```bash
mysql --version                 # 8.4.x
sudo systemctl enable --now mysql
sudo ss -ltnp | grep 3306       # must show 127.0.0.1:3306 (not 0.0.0.0) — MySQL is not reachable from outside
```

## 4. MySQL: the database, a user that can reach only JVzPay, and the trigger setting

> **Case matters on Linux.** On Windows/Laragon, MySQL ignores the case of database and table names; on Ubuntu it
> does not (`lower_case_table_names=0`). The database is **`JVzPay`** exactly — `jvzpay` would be another, empty
> database. All JVzPay table names are lowercase and every model, raw query and migration writes them the same way (a
> unit test, `tests/deployment.test.js`, checks this). Never change `lower_case_table_names`; it cannot be changed
> after MySQL is installed.

Create the database and the user. The password is generated and shown once: **copy it**, it goes into `.env`.

```bash
DB_PASS="$(openssl rand -base64 24 | tr -d '/+=')"; echo "DB_PASSWORD=$DB_PASS"
sudo mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`JVzPay\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'jvzpay'@'localhost' IDENTIFIED BY '${DB_PASS}';
CREATE USER IF NOT EXISTS 'jvzpay'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`JVzPay\`.* TO 'jvzpay'@'localhost';
GRANT ALL PRIVILEGES ON \`JVzPay\`.* TO 'jvzpay'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
# check: the user sees only JVzPay (plus MySQL's own information_schema / performance_schema)
mysql -h 127.0.0.1 -u jvzpay -p"$DB_PASS" -e "SELECT CURRENT_USER(); SHOW DATABASES;"
```

The `jvzpay` user has every privilege **on the JVzPay database only** (`JVzPay.*`): it cannot see or change any other
database, create users, or read server files. Both `localhost` and `127.0.0.1` accounts exist so that the app (TCP to
127.0.0.1) and the `mysql` command line both work.

**Triggers need one setting (do this before `npm run migrate`).** Migrations `001` and `004` create triggers (the audit
log and released payroll are append-only). MySQL 8.4 on Ubuntu has **binary logging on**, and then a user without the
SUPER privilege — like `jvzpay` — may create triggers or stored functions only when `log_bin_trust_function_creators`
is 1. Run this **once**; `PERSIST` keeps it after a MySQL restart:

```bash
sudo mysql -e "SET PERSIST log_bin_trust_function_creators = 1;"
sudo mysql -e "SELECT @@log_bin, @@log_bin_trust_function_creators;"    # 1   1
```

Without it, `npm run migrate` stops at the first trigger with `ER_BINLOG_CREATE_ROUTINE_NEED_SUPER` and prints this
same command. `npm run restore` needs it too (a backup re-creates the triggers).

## 5. The code and `.env`

```bash
cd ~
git clone https://github.com/khairochix22/JVzPay.git
cd JVzPay
git checkout main            # the branch you deploy (integration-alignment until it is merged)
npm ci --omit=dev            # exact versions from package-lock.json, no dev tools
```

(If the repository is private: GitHub → Settings → Developer settings → Fine-grained token with read access to this
repository, and use it as the password when `git clone` asks.)

**Create `.env`.** Choose ONE:

* **Brand-new database** (first deployment): generates a new SESSION_SECRET and DATA_ENCRYPTION_KEY.

  ```bash
  npm run setup -- --production
  ```

* **Moving an existing database** to this server: copy the template and put in the **existing** DATA_ENCRYPTION_KEY
  from your key backup (§9). A new key cannot read the bank and ID numbers already stored.

  ```bash
  cp .env.production.example .env
  ```

Then edit it and fill in every empty value:

```bash
chmod 600 .env
nano .env        # Ctrl+O Enter to save, Ctrl+X to quit
```

What to fill in (every setting is explained in `.env.production.example`, full list in §15):

| Setting | Value |
|---|---|
| `DB_PASSWORD` | the password printed in §4 |
| `SESSION_SECRET`, `DATA_ENCRYPTION_KEY` | already filled by `npm run setup -- --production` (else: `openssl rand -hex 48` / the key from your backup) |
| `HR_API_TOKEN` | the API key the **HR team** created for Accounting |
| `CRM_API_SECRET`, `CRM_INBOUND_SECRET` | the two secrets agreed with the **CRM team** (`openssl rand -hex 32` each; CRM keeps them as `JVZ_CRM_INBOUND_SECRET_ACCOUNTING` and `JVZ_SECRET_ACCOUNTING`) |
| `INVENTORY_API_TOKEN` | the token the **Inventory team** created for JVzPay to read its outbox |
| `PENDING_INTEGRATIONS` | only while a team's server is not ready: e.g. `hr,inventory`. Empty when all four run |
| `COOKIE_SECURE` | leave `false` now; set `true` after HTTPS works (§8) |

**The app refuses to start** in production when a required value is missing, a secret is too short or still a
placeholder, two secrets are the same, an address is not https, `HOST` is not 127.0.0.1, `DB_USER` is root, or
DATA_ENCRYPTION_KEY cannot decrypt the data already in the database. The message names the setting, for example:

```
❌ JVzPay will not start (NODE_ENV=production). Fix these settings in .env, then restart:
   - CRM_INBOUND_SECRET is too short (12 characters; at least 32): given by CRM's team or agreed with them …
```

## 6. Database tables, base configuration and the first Accounting Supervisor

Make sure you did the trigger setting of §4 first.

```bash
cd ~/JVzPay
npm run migrate                 # creates all tables (001 … 026)
npm run migrate -- --status     # every line ✅ applied
```

Migrations are **safe to re-run after a failure**: each statement that succeeded is recorded, and `npm run migrate`
continues with the one that failed once you fixed the cause (the error message tells you how). Never edit a migration
that is already applied; never use `--fresh` on a database with real data (it drops everything).

**Base configuration (no demo data)** and **the first Accounting Supervisor** in one command. `npm run seed` writes only
configuration — the four roles and their permissions, chart of accounts, transaction categories, leave types, salary
components, settings, statutory reference tables (marked UNVERIFIED: check them before the first real payroll) and the
department/position starter list — **no employees, no payroll, no demo accounts**. Employees come from HR (Sync now).

The first Accounting Supervisor is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Type them at the prompts so the
password is never written to `.env` or your shell history (10–72 characters, letters **and** numbers, not containing
the part of the email before `@`):

```bash
cd ~/JVzPay
read -r -p "First Accounting Supervisor email: " ADMIN_EMAIL
read -r -s -p "Temporary password: " ADMIN_PASSWORD; echo
ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" ADMIN_NAME="Accounting Supervisor" npm run seed
unset ADMIN_PASSWORD
```

Expected: `✅ Accounting Supervisor created: <email> (must change password at first login)`. Running the seed again
later is safe: it never overwrites edited settings and never creates a second account for the same email. Further
accounts are created by this supervisor in the app (Users → User Accounts), or by employees registering with their HR
Employee ID at `https://johnvivz-pay.duckdns.org/register/employee`.

## 7. Start it with PM2

```bash
cd ~/JVzPay
pm2 start ecosystem.config.cjs
pm2 status                      # jvzpay  online
pm2 logs jvzpay --lines 30      # "XianFire running at http://127.0.0.1:3002  (public address: https://johnvivz-pay.duckdns.org)"
curl -s http://127.0.0.1:3002/health     # {"status":"ok"}

# start again after a reboot
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
#   ↑ prints a "sudo env PATH=… pm2 startup …" line: copy that line and run it, then:
pm2 save
# keep the log files small
pm2 install pm2-logrotate
```

`ecosystem.config.cjs` runs **one** process (`exec_mode: "fork"`, `instances: 1`) of `index.js` with
`NODE_ENV=production`. `index.js` starts the server whenever it is loaded — there is deliberately no "main module"
check (`require.main === module` / `import.meta.url === process.argv[1]`): under PM2 the main module is PM2's own file,
so such a check would make the app exit with code 0 and PM2 restart it forever. If a start-up check fails, PM2 stops
after 10 quick restarts; read `pm2 logs jvzpay` for the reason.

## 8. Nginx and HTTPS (Let's Encrypt)

```bash
cd ~/JVzPay
sudo cp deploy/nginx-site.conf /etc/nginx/sites-available/jvzpay
sudo nano /etc/nginx/sites-available/jvzpay
#   in the "location ~* ^/api/(integration|v1)" block, replace 203.0.113.10 / .20 / .30 with the Elastic IPs of
#   HR, CRM and Inventory (the allow lines). Save.
sudo ln -sf /etc/nginx/sites-available/jvzpay /etc/nginx/sites-enabled/jvzpay
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
curl -s http://johnvivz-pay.duckdns.org/health        # {"status":"ok"}

# HTTPS certificate; certbot adds port 443 to the site and redirects http to https. Renewal is automatic.
sudo certbot --nginx -d johnvivz-pay.duckdns.org --redirect -m <your-email> --agree-tos --no-eff-email
sudo certbot renew --dry-run
curl -s https://johnvivz-pay.duckdns.org/health       # {"status":"ok"}
```

What the site does (`deploy/nginx-site.conf`):

* `proxy_pass http://jvzpay` (= 127.0.0.1:3002) **with no path after it**, so the path, the query string and the body
  reach the app exactly as the caller sent them. The other apps' signed requests (`X-JVZ-Signature`) are checked on
  `METHOD + path?query + timestamp + SHA-256(raw body)`; any rewrite would break them. Do not add a path, a trailing
  slash or a `rewrite` to these locations.
* `X-Forwarded-For` (the visitor's address, set by Nginx — a caller cannot fake it) and `X-Forwarded-Proto` (https).
  With `TRUST_PROXY=1` the app uses them for sign-in rate limits, the audit log, sign-in history and secure cookies.
* `/api/integration/` (and the older `/api/v1/`) only from the three Elastic IPs; everyone else gets 403. The match is
  case-insensitive because Express routes are, so `/API/...` cannot slip past it.
* `client_max_body_size 8m` (the app accepts uploads up to 5 MB).

**Now switch on secure cookies** (only after `https://johnvivz-pay.duckdns.org` opens):

```bash
cd ~/JVzPay
sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' .env
pm2 restart jvzpay --update-env
```

| Setting | Laptop (Laragon, http) | AWS server |
|---|---|---|
| `NODE_ENV` | development | production |
| `HOST` | empty (every address, so teammates on the Wi-Fi can connect) | 127.0.0.1 |
| `TRUST_PROXY` | false | 1 |
| `COOKIE_SECURE` | false (sign-in works over http) | true once https works |
| `PUBLIC_BASE_URL` | empty (links use the browser's address) | https://johnvivz-pay.duckdns.org |
| `HTTPS_CERT_FILE` / `HTTPS_KEY_FILE` | empty (or a self-signed pair) | **empty** — Nginx does TLS |

Every link handed to a person — the password reset link and the employee registration link
(`https://johnvivz-pay.duckdns.org/register/employee`) — is built from `PUBLIC_BASE_URL`, never from the request's
`Host` header.

## 9. The encryption key and backups

### DATA_ENCRYPTION_KEY — read this

* **What it protects:** bank account numbers and SSS / PhilHealth / Pag-IBIG / TIN numbers are stored encrypted
  (AES-256-GCM) with this key (all `*_enc` columns). The key is **not** in the database.
* **Where it lives:** one line in `~/JVzPay/.env` on the server (`DATA_ENCRYPTION_KEY=` + 64 hex characters),
  readable only by the `ubuntu` user (`chmod 600`).
* **Back it up separately**, right after the first start: in the team's password manager, and/or printed and kept in a
  safe. **Never** in the same place as the database backups, never in git, never in a chat. A thief with backup + key
  can read every number; with only the backup, nothing.
  ```bash
  grep '^DATA_ENCRYPTION_KEY=' ~/JVzPay/.env      # copy this line into the password manager
  ```
* **Losing it makes those fields unreadable — permanently.** No one, not even with database access, can recover the
  numbers; every employee would have to enrol their bank account and government IDs again. A database backup restored
  without its key has the same problem.
* **Never generate a new key for an existing database.** The app checks at start-up: if the key cannot decrypt a stored
  number, it refuses to start (`DATA_ENCRYPTION_KEY does not match the data …`) instead of showing `••••` or saving new
  numbers under the wrong key.
* `SESSION_SECRET` can be changed at any time (everyone is signed out, nothing else happens). `AUDIT_SEAL_KEY`, if you
  set one, belongs with the encryption key.

### Database backups

Two kinds, both on:

1. **The app's own daily backup** (Backup & Maintenance page, time and retention in System Settings) into
   `BACKUP_DIR=/var/lib/jvzpay/backups`. It is part of the scheduler (§12).
2. **A cron job** with `scripts/backup-db.sh`: `mysqldump --single-transaction --routines --triggers` → gzip, checked
   for completeness, into `/var/backups/jvzpay/jvzpay-YYYYMMDD-HHMMSS.sql.gz`, **keeping 7 days**:

   ```bash
   bash ~/JVzPay/scripts/backup-db.sh            # try it once
   ls -lh /var/backups/jvzpay/
   crontab -e                                     # choose nano, add this line, save:
   30 1 * * * /bin/bash /home/ubuntu/JVzPay/scripts/backup-db.sh >> /home/ubuntu/jvzpay-backup.log 2>&1
   ```

   The script reads the database settings from `.env` and passes the password to `mysqldump` through a temporary
   option file (not the command line). Change the folder or the days with `BACKUP_DEST=… KEEP_DAYS=…`.

**Copy backups off the server** regularly (they are lost with the instance): for example
`scp -i johnvivz-pay.pem ubuntu@johnvivz-pay.duckdns.org:/var/backups/jvzpay/*.sql.gz .` from your laptop, or an S3
bucket. Also copy the uploaded documents: `tar czf ~/uploads-$(date +%F).tgz -C /var/lib/jvzpay uploads`.

**Restore** (replaces all data; it first saves a safety copy of the current data):

```bash
pm2 stop jvzpay
cd ~/JVzPay && npm run restore -- /var/backups/jvzpay/jvzpay-20261123-013000.sql.gz
pm2 start jvzpay
```

## 10. First sign-in and the integration tokens

1. Open https://johnvivz-pay.duckdns.org, sign in with the first Accounting Supervisor and choose a new password.
2. **System → Integration** (`/settings/integration`, permission *integration.manage*, Accounting Supervisor):
   * The HR card shows the connection; press **Sync now** to pull employees, departments and approved pay. It then runs
     every 15 minutes by itself.
   * The Inventory card: press **Poll now** to read Inventory's outbox. It then runs every minute by itself.
   * **Service tokens** card → *Application*: choose the app → *Label*: e.g. `Inventory production server` → **Create
     token**. The token (`jvz_…`) is shown **once**: copy it and give it privately to that team. JVzPay keeps only its
     fingerprint; **Revoke** stops it at once.

   | Token for | Needed? | What the other app uses it for |
   |---|---|---|
   | **Inventory** | **yes** | `Authorization: Bearer <token>` for the department login (`POST /api/integration/v1/auth/login`) and its read API (`/api/integration/v1/inventory/…`) |
   | **HR** | only if HR reads JVzPay | its read API (`/api/integration/v1/hr/…`: attendance, leave, payslips, payroll periods). HR is pull-only; JVzPay calls HR with `HR_API_TOKEN` |
   | **CRM** | no (CRM signs with `CRM_INBOUND_SECRET`) | optional second method for CRM's calls |

3. Give each team: our base address `https://johnvivz-pay.duckdns.org`, the API path `/api/integration/v1`, our
   Elastic IP (for their allow list) and their token or secret. They can test with the signed or token-authenticated
   `GET /api/integration/v1/health` (and CRM with `POST /api/integration/v1/test/echo`).

Tokens and secrets that **we** put in `.env` come from the other teams' screens: `HR_API_TOKEN` from HR's admin page,
`INVENTORY_API_TOKEN` from Inventory's, and the two CRM secrets agreed with CRM. After changing `.env`:
`pm2 restart jvzpay --update-env`.

## 11. Health checks

| URL | Who | Answer |
|---|---|---|
| `GET /health` | anyone (uptime monitor, e.g. UptimeRobot on `https://johnvivz-pay.duckdns.org/health`) | `200 {"status":"ok"}` — the app answers; no database call, no data |
| `GET /healthz` | anyone | `200 {"status":"ok","database":"ok",…}` or `503` when MySQL does not answer |
| `GET /api/integration/v1/health` | the other apps (signed or bearer token, allow-listed IPs) | `200 {"status":"ok","app":"johnvivz_accounting",…}`, `401` with wrong credentials |

## 12. The scheduler runs once per server

The background jobs run **inside the app process** (`lib/scheduler.js`), not in cron:

| Every | Job |
|---|---|
| minute | seal new audit records; send queued events; read Inventory's outbox |
| 15 minutes | pull HR (employees, departments, approved compensation) |
| hour | create the kinsenas/katapusan payroll periods and compute payroll after each cutoff |
| day (System Settings time, default 02:00) | automatic backup, retention clean-up |

So there must be **exactly one** JVzPay process per server: PM2 with `instances: 1` in fork mode
(`ecosystem.config.cjs`). Never use `pm2 scale`, cluster mode or a second copy of the app on the same database — every
job would run twice (double payroll computation, double backups). As a safety net, a PM2 cluster instance other than 0
does not start the scheduler. `DISABLE_SCHEDULER=1` switches it off (tests only).

## 13. Updates, logs, roll back

**Update to a new version:**

```bash
cd ~/JVzPay
bash scripts/backup-db.sh                         # 1. backup first
git rev-parse HEAD > ~/jvzpay-previous-commit     # 2. remember the running version
git pull --ff-only                                # 3. new code
npm ci --omit=dev                                 # 4. dependencies
npm run migrate                                   # 5. new tables/columns, if any
pm2 restart jvzpay --update-env                   # 6. restart
curl -s https://johnvivz-pay.duckdns.org/health   # 7. {"status":"ok"}
pm2 logs jvzpay --lines 50 --nostream
```

**Logs:**

```bash
pm2 logs jvzpay                          # live (Ctrl+C to leave)
pm2 logs jvzpay --lines 200 --nostream   # last 200 lines
ls ~/.pm2/logs/                          # jvzpay-out.log, jvzpay-error.log
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
sudo tail -f /var/log/mysql/error.log
tail ~/jvzpay-backup.log
```

Inside the app: System → Audit Logs, Security Monitor, Sign-in History, Integration (events received/sent, retries).

**Roll back** to the previous version:

```bash
cd ~/JVzPay
pm2 stop jvzpay
git checkout "$(cat ~/jvzpay-previous-commit)"
npm ci --omit=dev
# only if the update ran a new migration: put the database back as it was before the update
npm run restore -- /var/backups/jvzpay/<the backup from step 1>.sql.gz
pm2 start jvzpay
```

Migrations only go forward; going back means restoring the backup taken before the update (data entered since then is
lost, so roll back quickly). Return to the normal branch later with `git checkout main && git pull --ff-only`.

## 14. Troubleshooting

| You see | Cause and fix |
|---|---|
| `❌ JVzPay will not start … - <SETTING> …` in `pm2 logs` | Fix that line in `.env`, then `pm2 restart jvzpay --update-env`. |
| PM2 shows the app restarting over and over with exit code 0 | Something guards the start with a "main module" check. `index.js` must start the server unconditionally (it does); do not add such a check. |
| `502 Bad Gateway` | The app is not running: `pm2 status`, `pm2 logs jvzpay`. |
| Sign-in "works" but you land on the sign-in page again | `COOKIE_SECURE=true` while the site is still on http, or `TRUST_PROXY` not 1. Use https, set `TRUST_PROXY=1`. |
| Every visitor is `127.0.0.1` in Sign-in History | `TRUST_PROXY` is not 1. |
| Another app gets `403` from Nginx on `/api/integration/` | Its Elastic IP is not in the allow list of `/etc/nginx/sites-available/jvzpay`. |
| Another app gets `401 invalid_signature` | Different secret on the two sides, or the request was changed on the way (a proxy rewriting the path or body). |
| `401 stale_timestamp` | A server clock is wrong: `timedatectl` must say synchronized (on both servers). |
| `ER_BINLOG_CREATE_ROUTINE_NEED_SUPER` during migrate or restore | Run `sudo mysql -e "SET PERSIST log_bin_trust_function_creators = 1;"` (§4), then the same command again. |
| `Access denied for user 'jvzpay'` | Wrong `DB_PASSWORD`, or `DB_HOST` is not 127.0.0.1. |
| `Table 'JVzPay.xyz' doesn't exist` / `Unknown database 'jvzpay'` | Case: the database is `JVzPay`, tables are lowercase. |
| `DATA_ENCRYPTION_KEY does not match the data` | The key in `.env` is not the one this database was encrypted with: put back the key from your key backup. |

## 15. Every `.env` setting

The template with comments is `.env.production.example`. "Required" = the app refuses to start in production without
a valid value. Secrets: at least 32 characters (SESSION_SECRET 64, DB_PASSWORD 16), random, not a placeholder, all
different. Provided by: **US** = we generate it; **HR / CRM / INV** = that team; **BOTH** = agreed with that team.

| Setting | Required | By | Server value / example | Purpose |
|---|---|---|---|---|
| `NODE_ENV` | yes | US | `production` | turns on the production checks |
| `PORT` | | US | `3002` | port on 127.0.0.1 that Nginx forwards to |
| `HOST` | must be loopback | US | `127.0.0.1` | listen address (laptop: empty = all) |
| `PUBLIC_BASE_URL` | yes | US | `https://johnvivz-pay.duckdns.org` | start of every link given to people |
| `TRUST_PROXY` | (warned) | US | `1` | real client address/https from Nginx |
| `COOKIE_SECURE` | (warned) | US | `true` after certbot | session cookie only over https |
| `HTTPS_CERT_FILE`, `HTTPS_KEY_FILE` | must be empty | — | empty | direct TLS (laptops only) |
| `HTTP_REDIRECT_PORT` | | — | `0` | http→https redirect for direct TLS (laptops only) |
| `DB_HOST`, `DB_PORT` | yes | US | `127.0.0.1`, `3306` | MySQL on the same instance |
| `DB_NAME` | yes | US | `JVzPay` | exactly this case |
| `DB_USER` | yes, not root | US | `jvzpay` | user with access only to JVzPay |
| `DB_PASSWORD` | yes | US | `openssl rand -base64 24` | that user's password |
| `SESSION_SECRET` | yes | US | `openssl rand -hex 48` | signs session cookies |
| `DATA_ENCRYPTION_KEY` | yes | US | `openssl rand -hex 32` (once!) | encrypts bank and government ID numbers (§9) |
| `AUDIT_SEAL_KEY` | | US | empty or `openssl rand -hex 32` | seals the audit trail (default: from the encryption key) |
| `SESSION_IDLE_MINUTES` | | US | `30` | idle sign-out |
| `MAX_FAILED_LOGINS`, `LOCKOUT_MINUTES` | | US | `3`, `15` | account lock after wrong passwords |
| `RESET_LINK_MINUTES` | | US | `30` | reset link lifetime |
| `COMPANY_NAME`, `COMPANY_ADDRESS` | | US | JohnVivz Grocery Store, Bongabong… | printed on payslips/reports |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | seed only | US | empty in `.env` (typed at the prompt, §6) | first Accounting Supervisor |
| `DISABLE_SCHEDULER` | | US | `0` | 1 = background jobs off (tests) |
| `BACKUP_DIR`, `UPLOAD_DIR` | | US | `/var/lib/jvzpay/backups`, `/var/lib/jvzpay/uploads` | app backups / uploaded documents |
| `MYSQL_PATH`, `MYSQLDUMP_PATH` | | US | empty (on the PATH) | MySQL tool locations |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | | — | empty | not used by this version |
| `PENDING_INTEGRATIONS` | | US | empty (temporarily e.g. `hr,inventory`) | apps whose server is not ready yet |
| `HR_API_URL` | yes | HR | `https://johnvivz-hr.duckdns.org` | HR's base address |
| `HR_API_PREFIX` | yes | HR | `/api/integration/v1` | HR's API path |
| `HR_API_TOKEN` | yes | HR | the key HR created for Accounting | JVzPay's bearer token at HR (pull + registration check) |
| `HR_API_SECRET` | | BOTH | empty unless HR checks signatures | signs JVzPay's calls to HR |
| `HR_INBOUND_SECRET` | | BOTH | empty unless HR signs calls to us | checks HR's signed calls |
| `HR_EVENTS_ENABLED` | | — | `false` | HR has no /events (pull-only) |
| `HR_COMPENSATION_PATH` | | HR | `/payroll/employees/{identifier}/compensation` | HR's compensation endpoint |
| `CRM_API_URL` | yes | CRM | `https://johnvivz-crm.duckdns.org` | CRM's base address |
| `CRM_API_PREFIX` | yes | CRM | `/api/integration/v1` | CRM's API path |
| `CRM_API_SECRET` | yes | BOTH | `openssl rand -hex 32` (CRM: `JVZ_CRM_INBOUND_SECRET_ACCOUNTING`) | signs JVzPay's calls to CRM |
| `CRM_INBOUND_SECRET` | yes | BOTH | `openssl rand -hex 32` (CRM: `JVZ_SECRET_ACCOUNTING`) | checks CRM's signed calls (sales events, department login) |
| `CRM_API_TOKEN` | | CRM | empty | optional bearer token at CRM |
| `CRM_EVENTS_ENABLED` | | — | `true` | queue events for CRM |
| `INVENTORY_API_URL` | yes | INV | `https://johnvivz-inventory.duckdns.org` | Inventory's base address; outbox = `…/api/integration/v1/accounting/outbox` |
| `INVENTORY_API_PREFIX` | yes | INV | `/api/integration/v1` | Inventory's API path |
| `INVENTORY_API_TOKEN` | yes | INV | the token Inventory created for JVzPay | reads + acknowledges Inventory's outbox |
| `INVENTORY_POLL_ENABLED` | | — | `true` | read the outbox every minute |
| `INVENTORY_API_SECRET` | | BOTH | empty unless Inventory checks signatures | signs JVzPay's calls to Inventory |
| `INVENTORY_INBOUND_SECRET` | | BOTH | empty (Inventory uses a token from §10) | checks Inventory's signed calls |
| `INVENTORY_EVENTS_ENABLED` | | — | `true` | queue events for Inventory |
| `CRM_DEPARTMENT_CODES`, `INVENTORY_DEPARTMENT_CODES` | | HR | `CRM`, `INVENTORY` | HR department codes that sign in to CRM / Inventory |
| `ACCOUNTING_DEPARTMENT_CODE` | | HR | `PAYROLL_ACCOUNTING` | HR's code of our department |
| `POSITION_ROLES` | | HR | `Accounting Supervisor=accounting_supervisor,…` | HR titles → JVzPay roles |
| `DEPARTMENT_SUPERVISOR_TITLES` | | HR | `CRM=CRM Manager\|Team Leader;…` | first approvers per department |

Test-only variables (never on a server): `E2E_PORT`, `E2E_BROWSER`, `FAKE_HR_TOKEN`, `FAKE_INVENTORY_TOKEN`;
`XIAN_ELECTRON` is set only by an Electron wrapper. PM2 sets `NODE_APP_INSTANCE` itself.
