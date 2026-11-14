# Personal data breach response

For the store owner, the Data Protection Officer (DPO) and the Super Admin. Based on the Data Privacy Act of 2012
(RA 10173) and NPC Circular 16-03 on personal data breach management. Have this checked by whoever advises the store
on legal matters; the NPC's current circulars prevail over this summary.

## What counts as a breach
Personal data in JVzPay is lost, destroyed, changed or seen by someone who should not have it. Examples: a stolen
computer or backup drive, a leaked `.env` file, an account used by the wrong person, a payslip or report sent to the
wrong person, or a failed **Verify audit trail** check.

## Clock
| When | What |
|---|---|
| Immediately | Contain it and tell the DPO |
| Within **72 hours** of knowing (or reasonably believing) a reportable breach happened | Notify the National Privacy Commission and the affected people |
| Within **5 days** | Send the NPC the full breach report, unless the NPC allows more time |

A breach is reportable when it involves sensitive personal information (for JVzPay: government ID numbers,
salaries, health-related leave documents) or information that could enable identity fraud (bank accounts), and is
likely to put the affected people at real risk. When in doubt, report.

## Steps
1. **Contain.** Disconnect the affected computer from the network if needed. In JVzPay: deactivate the affected
   accounts (User Accounts), use "Sign out of all devices", and change the database password if it may be known.
   If `.env` leaked, plan to rotate `DATA_ENCRYPTION_KEY` with a developer.
2. **Preserve evidence.** Do not delete anything. Export the relevant audit trail and Sign-in History pages, and make a backup.
3. **Assess.** Whose data, which fields, how many people, since when, and whether it was encrypted.
   Bank and ID numbers in JVzPay are encrypted; they are exposed only if the `.env` key was also taken.
4. **Notify the NPC** within 72 hours: nature of the breach, data involved, people affected, measures taken, and
   the DPO's contact details.
5. **Notify affected people** within the same period: what happened, what data, what the store is doing, what they
   should do (for example watch their bank account), and whom to contact.
6. **Recover.** Restore from backup if data was lost or changed ([DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)).
   Fix the cause.
7. **Record and learn.** Keep a written record of every breach, reportable or not, with the decisions taken.
   Review it with the owner and update this procedure.

## Contacts
Keep the DPO's name and contact details in System Settings → Privacy; they appear on the Privacy Notice.
The National Privacy Commission's current reporting channel is published on privacy.gov.ph.
