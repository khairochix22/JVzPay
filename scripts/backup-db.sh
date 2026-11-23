#!/usr/bin/env bash
# Daily MySQL backup of the JVzPay database for the AWS server (docs/DEPLOY-AWS.md §9). Keeps 7 days.
#
#   bash scripts/backup-db.sh                       one backup now
#   crontab -e  →  30 1 * * * /bin/bash /home/ubuntu/JVzPay/scripts/backup-db.sh >> /home/ubuntu/jvzpay-backup.log 2>&1
#
# Reads DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD from the app's .env (the jvzpay MySQL user). The password
# goes to mysqldump through a temporary option file readable only by you — never on the command line, where `ps`
# would show it.
#
# Output: $BACKUP_DEST/jvzpay-YYYYMMDD-HHMMSS.sql.gz (default /var/backups/jvzpay), the same format as the app's own
# backups, so `npm run restore -- /var/backups/jvzpay/<file>` can restore it.
#
# These dumps contain bank and government ID numbers ENCRYPTED. They are readable only with DATA_ENCRYPTION_KEY, which is
# NOT in the dump: keep a copy of that key somewhere else (password manager / safe), never next to these files.
set -euo pipefail
umask 077

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DEST="${BACKUP_DEST:-/var/backups/jvzpay}"
KEEP_DAYS="${KEEP_DAYS:-7}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { log "ERROR: $*"; exit 1; }

[ -r "$ENV_FILE" ] || fail "cannot read $ENV_FILE"

# value of KEY in .env (last one wins), without surrounding quotes; nothing else in .env is executed or exported
env_value() {
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%$'\r'}"
  if [[ "$line" =~ ^\"(.*)\"$ ]] || [[ "$line" =~ ^\'(.*)\'$ ]]; then line="${BASH_REMATCH[1]}"; fi
  printf '%s' "$line"
}

DB_HOST="$(env_value DB_HOST)"; DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="$(env_value DB_PORT)"; DB_PORT="${DB_PORT:-3306}"
DB_NAME="$(env_value DB_NAME)"; DB_NAME="${DB_NAME:-JVzPay}"
DB_USER="$(env_value DB_USER)"
DB_PASSWORD="$(env_value DB_PASSWORD)"
[ -n "$DB_USER" ] || fail "DB_USER is empty in $ENV_FILE"
command -v mysqldump >/dev/null || fail "mysqldump not found (sudo apt install mysql-client)"

mkdir -p "$BACKUP_DEST"
chmod 700 "$BACKUP_DEST"

CNF="$(mktemp)"
TMP_OUT=""
cleanup() { rm -f "$CNF"; if [ -n "$TMP_OUT" ]; then rm -f "$TMP_OUT"; fi; return 0; }
trap cleanup EXIT
# option file: the password may contain any character, so it is quoted and its \ and " escaped
esc="${DB_PASSWORD//\\/\\\\}"; esc="${esc//\"/\\\"}"
printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword="%s"\n' "$DB_HOST" "$DB_PORT" "$DB_USER" "$esc" > "$CNF"

STAMP="$(TZ=Asia/Manila date '+%Y%m%d-%H%M%S')"
OUT="$BACKUP_DEST/jvzpay-$STAMP.sql.gz"
TMP_OUT="$OUT.partial"

log "backing up database $DB_NAME to $OUT"
# --single-transaction: consistent copy without locking the app; --routines --triggers: the payroll/audit triggers;
# --no-tablespaces: the jvzpay user has no PROCESS privilege (and needs none)
mysqldump --defaults-extra-file="$CNF" --single-transaction --routines --triggers --no-tablespaces \
  --default-character-set=utf8mb4 --set-gtid-purged=OFF "$DB_NAME" | gzip -9 > "$TMP_OUT"

# a complete dump ends with "-- Dump completed"; anything else is a broken backup
gzip -t "$TMP_OUT" || fail "the backup file is damaged"
zcat "$TMP_OUT" | tail -n 1 | grep -q -- "-- Dump completed" || fail "mysqldump did not finish; backup discarded"
mv "$TMP_OUT" "$OUT"
TMP_OUT=""
log "done: $(du -h "$OUT" | cut -f1)"

# keep KEEP_DAYS days: delete older JVzPay backups in this folder only
find "$BACKUP_DEST" -maxdepth 1 -type f -name 'jvzpay-*.sql.gz' -mtime +"$((KEEP_DAYS - 1))" -print -delete | sed 's/^/removed old backup: /'
log "backups kept: $(find "$BACKUP_DEST" -maxdepth 1 -type f -name 'jvzpay-*.sql.gz' | wc -l)"
