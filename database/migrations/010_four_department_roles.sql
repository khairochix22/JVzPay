-- The JOHNVIVZ Accounting & Payroll department has four roles (owner's decision, 2026-11-11):
-- Accounting Supervisor → Accounting Staff and Payroll Staff, plus Employee Self-Service. There is no Super Admin.
--
-- * Every Payroll Supervisor and Super Admin account moves to the Accounting Supervisor role and keeps its password;
--   the Accounting Supervisor receives both roles' grants (user accounts, roles, settings, backups, all approvals).
-- * Works whether or not an accounting_supervisor role already exists (a seed may have created it first).
-- * Payroll Staff no longer prepare accounting entries; that is Accounting Staff work.
-- On a brand-new database there are no roles yet, so these statements change nothing and the seed creates the four roles.

INSERT INTO roles (code, name, description)
SELECT 'accounting_supervisor', 'Accounting Supervisor',
       'Runs the department: approves financial transactions, payroll batches and requests, manages user accounts, settings and backups, and reviews the audit trail.'
  FROM roles WHERE code IN ('payroll_supervisor', 'super_admin')
   AND NOT EXISTS (SELECT 1 FROM (SELECT code FROM roles) r WHERE r.code = 'accounting_supervisor')
 LIMIT 1;

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT sup.id, rp.permission_id
  FROM role_permissions rp
  JOIN roles old ON old.id = rp.role_id AND old.code IN ('payroll_supervisor', 'super_admin')
  JOIN roles sup ON sup.code = 'accounting_supervisor';

-- includes deactivated and removed accounts, so no user is left pointing at a role that no longer exists
UPDATE users u
  JOIN roles old ON old.id = u.role_id AND old.code IN ('payroll_supervisor', 'super_admin')
  JOIN roles sup ON sup.code = 'accounting_supervisor'
   SET u.role_id = sup.id;

-- their role_permissions rows go with them (ON DELETE CASCADE)
DELETE FROM roles WHERE code IN ('payroll_supervisor', 'super_admin');

DELETE rp FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id AND r.code = 'payroll_staff'
  JOIN permissions p ON p.id = rp.permission_id AND p.code = 'accounting.prepare';

UPDATE roles SET description = 'Runs the department: approves financial transactions, payroll batches and requests, manages user accounts, settings and backups, and reviews the audit trail.' WHERE code = 'accounting_supervisor';
UPDATE roles SET description = 'Records revenue and expenses for approval, prepares journals and financial reports.' WHERE code = 'accounting_staff';
UPDATE roles SET description = 'Prepares attendance, computes payroll, manages payslips and submits batches for approval.' WHERE code = 'payroll_staff';
