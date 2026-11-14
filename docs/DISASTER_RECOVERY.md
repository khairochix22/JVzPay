# JVzPay disaster recovery plan

For the Super Admin and whoever looks after the store's computer.

## What must be protected
| Item | Where | Why it matters |
|---|---|---|
| Database | MySQL database `JVzPay` | All payroll, accounting and audit records |
| `.env` file | Project folder | Holds `DATA_ENCRYPTION_KEY`. **Without it, bank and government ID numbers in every backup are unreadable.** |
| Uploaded documents | `storage/uploads` | Medical certificates, bank proofs, receipts |
| Backups | `storage/backups` | Daily database copies |

## Targets
- **Data loss at most one day (RPO 24 hours):** the automatic backup runs daily. Make a manual backup before payroll release and month-end closing for a tighter point.
- **Back in service within half a day (RTO 4 hours)** on a replacement computer with the steps below.

## Routine (prevention)
1. **Daily, automatic:** check Backup & Maintenance shows a recent "Last automatic backup". A failure also appears as a notification.
2. **Weekly:** copy `storage/backups` (newest file), `storage/uploads` and `.env` to an external drive kept away from the store, or to encrypted cloud storage. Keep `.env` separate from the backups if possible.
3. **Monthly:** Security Monitor → **Verify audit trail now**.
4. **Every three months:** practise a restore on a spare computer (below) so the steps are known to work.

## Restoring
1. Install Laragon (MySQL 8.4) and Node.js; copy the project folder.
2. Put the saved `.env` back in the project folder. Use the **original** file: a new `DATA_ENCRYPTION_KEY` cannot read the old data.
3. Run `npm install`, then `npm run migrate`.
4. Copy the saved `storage/uploads` back into place.
5. Stop the app, then run `npm run restore -- storage/backups/<newest file>.sql.gz` and type the database name when asked. The command checks the file first and saves a safety copy of whatever was there.
6. Start the app (`npm run dev`) and sign in as Super Admin.
7. **Verify:** open a recent payslip and a journal entry; Security Monitor → **Verify audit trail now** should pass.
8. Record the incident and the restore in a note for the owner; if personal data was lost or exposed, follow [BREACH_RESPONSE.md](BREACH_RESPONSE.md).

## Common situations
| Situation | Action |
|---|---|
| Computer will not start | Restore on another computer (all steps above) |
| A record was entered wrongly | Do **not** restore. Use the correction workflows (payroll adjustment, journal reversal) so the history stays honest |
| Database damaged after a power cut | Stop the app; restore the newest backup |
| `.env` lost, backups intact | Records restore, but encrypted bank and ID numbers must be collected again; tell affected employees |
| Ransomware or suspected break-in | Disconnect the computer from the network, do not pay, follow [BREACH_RESPONSE.md](BREACH_RESPONSE.md), restore from an offline copy |
