# JVzPay data retention policy

For the store owner, the DPO and the Super Admin. The periods for business records follow the longer of the labour and
tax rules as generally understood (employment records at least 3 years after the last entry; tax and accounting
records up to 10 years). Have them confirmed by the store's accountant or legal adviser.

| Data | Kept for | Then | Automatic? |
|---|---|---|---|
| Payroll records, payslips, journals, financial statements | 10 years after the year they belong to | Archive, then delete with the owner's approval | No: never deleted by the system |
| Employee records, salary and employment history | At least 3 years after the employee leaves (longer if tied to payroll above) | Review with the owner | No |
| Attendance, leave and overtime | 3 years after the record | Review with the owner | No |
| Audit trail | As long as the payroll and financial records it explains | Never edited or deleted | Protected and sealed |
| Uploaded supporting documents | Same as the record they support | Removed together with that record | No |
| Signed-in sessions | Until they expire (30 minutes idle, 12 hours at most) | Deleted | Daily |
| Read notifications | 180 days | Deleted | Daily |
| Password reset links | 7 days after use or expiry | Deleted | Daily |
| Account requests: HR code | Until the request is decided | Erased | At the decision |
| Account requests: password of an approved request | Until approval | Erased (it now lives only on the account) | At the decision |
| Account requests: password of a rejected request | 30 days (so the person sees the reason at sign-in) | Erased | Daily |
| Database backups | 14 days (System Settings → Backup), never fewer than the newest 3 | Deleted from `storage/backups` | Daily |

Offsite copies of backups follow the same 14-day rotation unless the owner decides otherwise.
The daily clean-up is recorded in the audit trail as "Maintenance Cleanup".
