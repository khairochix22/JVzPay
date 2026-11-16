-- Owner's decision, 2026-11-13: leave, vacation leave cash conversion, overtime and attendance corrections are approved in
-- two steps. First the employee's immediate supervisor or team leader; only then may Accounting/Payroll Staff or the
-- Accounting Supervisor give the final approval. Nobody gives both approvals of the same request.
--  * The immediate supervisor comes from HR (employees.supervisor_hr_id). If that person has a JVzPay account they decide
--    under Team Approvals; if not, the request goes to HR, which returns the team leader's decision (RequestDecided).
--  * A Payroll/Accounting employee with no supervisor on record is approved first by an Accounting Supervisor.
-- Requests filed before this change, and overtime encoded by Payroll Staff, need no first approval ('not_required').

ALTER TABLE employees ADD COLUMN supervisor_hr_id VARCHAR(40) NULL AFTER hr_employee_id, ADD KEY ix_emp_supervisor (supervisor_hr_id);

ALTER TABLE leave_applications
  ADD COLUMN supervisor_status ENUM('pending','approved','rejected','not_required') NOT NULL DEFAULT 'not_required' AFTER status,
  ADD COLUMN supervisor_user_id BIGINT UNSIGNED NULL AFTER supervisor_status,
  ADD COLUMN supervisor_name VARCHAR(160) NULL AFTER supervisor_user_id,
  ADD COLUMN supervisor_decided_by BIGINT UNSIGNED NULL AFTER supervisor_name,
  ADD COLUMN supervisor_decided_at DATETIME NULL AFTER supervisor_decided_by,
  ADD COLUMN supervisor_remarks VARCHAR(500) NULL AFTER supervisor_decided_at;
ALTER TABLE overtime_records
  ADD COLUMN supervisor_status ENUM('pending','approved','rejected','not_required') NOT NULL DEFAULT 'not_required' AFTER status,
  ADD COLUMN supervisor_user_id BIGINT UNSIGNED NULL AFTER supervisor_status,
  ADD COLUMN supervisor_name VARCHAR(160) NULL AFTER supervisor_user_id,
  ADD COLUMN supervisor_decided_by BIGINT UNSIGNED NULL AFTER supervisor_name,
  ADD COLUMN supervisor_decided_at DATETIME NULL AFTER supervisor_decided_by,
  ADD COLUMN supervisor_remarks VARCHAR(500) NULL AFTER supervisor_decided_at;
ALTER TABLE attendance_correction_requests
  ADD COLUMN supervisor_status ENUM('pending','approved','rejected','not_required') NOT NULL DEFAULT 'not_required' AFTER status,
  ADD COLUMN supervisor_user_id BIGINT UNSIGNED NULL AFTER supervisor_status,
  ADD COLUMN supervisor_name VARCHAR(160) NULL AFTER supervisor_user_id,
  ADD COLUMN supervisor_decided_by BIGINT UNSIGNED NULL AFTER supervisor_name,
  ADD COLUMN supervisor_decided_at DATETIME NULL AFTER supervisor_decided_by,
  ADD COLUMN supervisor_remarks VARCHAR(500) NULL AFTER supervisor_decided_at;
ALTER TABLE leave_conversions
  ADD COLUMN routed_to ENUM('accounting','department') NOT NULL DEFAULT 'accounting' AFTER status,
  ADD COLUMN supervisor_status ENUM('pending','approved','rejected','not_required') NOT NULL DEFAULT 'not_required' AFTER routed_to,
  ADD COLUMN supervisor_user_id BIGINT UNSIGNED NULL AFTER supervisor_status,
  ADD COLUMN supervisor_name VARCHAR(160) NULL AFTER supervisor_user_id,
  ADD COLUMN supervisor_decided_by BIGINT UNSIGNED NULL AFTER supervisor_name,
  ADD COLUMN supervisor_decided_at DATETIME NULL AFTER supervisor_decided_by,
  ADD COLUMN supervisor_remarks VARCHAR(500) NULL AFTER supervisor_decided_at;

-- requests waiting for a first approval, per approver
ALTER TABLE leave_applications ADD KEY ix_la_sup (supervisor_status, supervisor_user_id);
ALTER TABLE overtime_records ADD KEY ix_ot_sup (supervisor_status, supervisor_user_id);
ALTER TABLE attendance_correction_requests ADD KEY ix_acr_sup (supervisor_status, supervisor_user_id);
ALTER TABLE leave_conversions ADD KEY ix_lc_sup (supervisor_status, supervisor_user_id);
