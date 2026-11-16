-- Owner's payroll schedule, 2026-11-13 (fixed; cannot be changed):
--   kinsenas  — work from the 1st to the 15th is paid on the 25th of the same month;
--   katapusan — work from the 16th to the end of the month is paid on the 10th of the next month.
-- Only the Accounting Supervisor creates payroll periods. Semi-monthly periods always follow the fixed dates; other
-- schedules (weekly or monthly, from an HR job offer) are special periods for chosen departments or employees.
-- A payday that falls on a weekend or a non-working holiday is released on the working day before it; the period
-- that holds the 13th-month pay (1–15 December) must be released by 24 December (PD 851).
-- There is one payroll run per period: it is computed automatically once the cutoff has passed (Payroll Staff can
-- recompute it) — nobody creates batches by hand any more.

ALTER TABLE payroll_periods
  ADD COLUMN cutoff ENUM('first_half','second_half','special') NOT NULL DEFAULT 'special' AFTER pay_frequency,
  ADD COLUMN department_id BIGINT UNSIGNED NULL AFTER cutoff,
  ADD COLUMN scope_key VARCHAR(60) NOT NULL DEFAULT 'all' AFTER department_id,
  ADD COLUMN release_date DATE NULL AFTER pay_date,
  ADD COLUMN include_thirteenth TINYINT(1) NOT NULL DEFAULT 0 AFTER release_date,
  ADD COLUMN compute_error VARCHAR(500) NULL AFTER include_thirteenth,
  ADD CONSTRAINT fk_period_dept FOREIGN KEY (department_id) REFERENCES departments (id);
ALTER TABLE payroll_periods DROP INDEX uq_period_range, ADD UNIQUE KEY uq_period_scope (pay_frequency, start_date, end_date, scope_key);
UPDATE payroll_periods SET cutoff = IF(DAY(start_date) = 1, 'first_half', 'second_half') WHERE pay_frequency = 'semi_monthly' AND DAY(start_date) IN (1, 16);
UPDATE payroll_periods SET release_date = pay_date WHERE release_date IS NULL;

-- the employees a special period is for, when it is not a whole department
CREATE TABLE payroll_period_employees (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_id   BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ppe (period_id, employee_id),
  CONSTRAINT fk_ppe_period FOREIGN KEY (period_id) REFERENCES payroll_periods (id) ON DELETE CASCADE,
  CONSTRAINT fk_ppe_emp    FOREIGN KEY (employee_id) REFERENCES employees (id)
) ENGINE=InnoDB;

-- runs computed automatically have no preparer; the approver still can never be the one who submitted
ALTER TABLE payroll_batches MODIFY prepared_by BIGINT UNSIGNED NULL;

INSERT IGNORE INTO salary_components (code, name, component_type, category, is_taxable, is_system) VALUES
  ('THIRTEENTH', '13th Month Pay', 'earning', 'bonus', 1, 1);

-- periods are the Accounting Supervisor's alone
DELETE rp FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id AND r.code <> 'accounting_supervisor'
  JOIN permissions p ON p.id = rp.permission_id AND p.code = 'payroll.periods';
UPDATE permissions SET description = 'Create payroll periods (semi-monthly on the fixed dates, or special periods for chosen departments or employees)' WHERE code = 'payroll.periods';
