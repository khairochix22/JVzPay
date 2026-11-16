-- Department approval routing (master prompt §VI; owner's decision 2026-11-11).
-- Leave and attendance-correction requests of Payroll/Accounting employees are decided in JVzPay by the Accounting
-- Supervisor. Requests of every other department go to HR, which finds the employee's own department supervisor and
-- sends the decision back (RequestDecided). JVzPay keeps the official record either way and tells HR the outcome.
ALTER TABLE leave_applications
  ADD COLUMN routed_to ENUM('accounting','department') NOT NULL DEFAULT 'accounting' AFTER status,
  ADD COLUMN approver_name VARCHAR(160) NULL AFTER decided_by;

ALTER TABLE attendance_correction_requests
  ADD COLUMN routed_to ENUM('accounting','department') NOT NULL DEFAULT 'accounting' AFTER status,
  ADD COLUMN approver_name VARCHAR(160) NULL AFTER decided_by;

-- a department supervisor deciding through HR has no JVzPay account: the decision keeps their name instead
ALTER TABLE leave_approvals MODIFY actor_id BIGINT UNSIGNED NULL, ADD COLUMN actor_name VARCHAR(160) NULL;
ALTER TABLE attendance_correction_approvals MODIFY actor_id BIGINT UNSIGNED NULL, ADD COLUMN actor_name VARCHAR(160) NULL;
