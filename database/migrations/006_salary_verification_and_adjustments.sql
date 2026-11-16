-- 006: supervisor verification of salary changes; accounting adjustments are manual journals with no income/expense category.

ALTER TABLE accounting_transactions MODIFY category_id BIGINT UNSIGNED NULL;

ALTER TABLE salary_history
  ADD COLUMN verification_status ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending' AFTER reason,
  ADD COLUMN verified_by BIGINT UNSIGNED NULL AFTER verification_status,
  ADD COLUMN verified_at DATETIME NULL AFTER verified_by,
  ADD COLUMN verification_remarks VARCHAR(255) NULL AFTER verified_at,
  ADD KEY ix_sh_verification (verification_status, created_at),
  ADD CONSTRAINT fk_sh_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE SET NULL;

-- starting salaries are part of the hire record and need no verification
UPDATE salary_history SET verification_status = 'verified' WHERE previous_amount IS NULL;
