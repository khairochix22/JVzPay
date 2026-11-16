-- Self-Service overtime applications (master prompt §V): an employee applies with the date, start and end time and the
-- reason; it is routed like leave (Accounting Supervisor for Payroll/Accounting, the department supervisor through HR
-- otherwise). Overtime encoded by Payroll Staff keeps working as before (source = 'encoded').
ALTER TABLE overtime_records
  ADD COLUMN request_no    VARCHAR(30)  NULL AFTER id,
  ADD COLUMN start_time    TIME         NULL AFTER work_date,
  ADD COLUMN end_time      TIME         NULL AFTER start_time,
  ADD COLUMN source        ENUM('encoded','employee') NOT NULL DEFAULT 'encoded' AFTER reason,
  ADD COLUMN routed_to     ENUM('accounting','department') NOT NULL DEFAULT 'accounting' AFTER status,
  ADD COLUMN approver_name VARCHAR(160) NULL AFTER decided_by,
  ADD UNIQUE KEY uq_ot_request (request_no);

INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('self.overtime', 'self', 'Apply for own overtime');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'self.overtime' WHERE r.code IN ('employee', 'payroll_staff', 'accounting_staff', 'accounting_supervisor');
