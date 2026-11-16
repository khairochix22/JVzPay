-- Owner's decisions, 2026-11-13:
--  1. Accounting Staff and Payroll Staff may approve or reject every request that comes from an employee — leave, overtime,
--     attendance corrections, bank enrollment, dependents and benefits (HMO, insurance), retirement withdrawals, vacation
--     leave conversions and salary loans. Nobody decides their own request or a request they filed for someone else.
--  2. Salary loans in Employee Self-Service, on the policy most Philippine companies use:
--     regular employees with at least 12 months of service; up to 2 months of basic salary; 3, 6 or 12 months to pay;
--     1% a month add-on interest; repaid by payroll deduction every payday; one loan at a time; the payday deduction may
--     not exceed 25% of the payday basic pay. The settings below hold every limit.

CREATE TABLE salary_loans (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loan_no            VARCHAR(30) NOT NULL,
  employee_id        BIGINT UNSIGNED NOT NULL,
  principal          DECIMAL(12,2) NOT NULL,
  term_months        TINYINT UNSIGNED NOT NULL,
  interest_rate      DECIMAL(6,4) NOT NULL,                -- per month, add-on
  interest_amount    DECIMAL(12,2) NOT NULL,
  total_payable      DECIMAL(12,2) NOT NULL,
  paydays            SMALLINT UNSIGNED NOT NULL,
  amortization       DECIMAL(12,2) NOT NULL,               -- deducted every payday
  monthly_basic      DECIMAL(12,2) NOT NULL,               -- basic salary when applied (monthly equivalent)
  purpose            VARCHAR(255) NOT NULL,
  status             ENUM('pending','approved','rejected','cancelled','released','paid') NOT NULL DEFAULT 'pending',
  active_flag        TINYINT(1) NULL DEFAULT 1,             -- 1 while pending, approved or released: one loan at a time
  requested_by       BIGINT UNSIGNED NOT NULL,
  requested_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by         BIGINT UNSIGNED NULL,
  decided_at         DATETIME NULL,
  decision_remarks   VARCHAR(500) NULL,
  released_by        BIGINT UNSIGNED NULL,
  released_at        DATETIME NULL,
  release_reference  VARCHAR(100) NULL,
  pay_item_id        BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sl_no (loan_no),
  UNIQUE KEY uq_sl_active (employee_id, active_flag),
  KEY ix_sl_status (status),
  CONSTRAINT fk_sl_emp  FOREIGN KEY (employee_id)  REFERENCES employees (id),
  CONSTRAINT fk_sl_req  FOREIGN KEY (requested_by) REFERENCES users (id),
  CONSTRAINT fk_sl_dec  FOREIGN KEY (decided_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_sl_rel  FOREIGN KEY (released_by)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_sl_item FOREIGN KEY (pay_item_id)  REFERENCES employee_pay_items (id),
  CONSTRAINT chk_sl_amounts CHECK (principal > 0 AND total_payable = principal + interest_amount AND amortization > 0 AND paydays > 0)
) ENGINE=InnoDB;

INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES
  ('loans.eligible_types', 'regular', 'string', 'loans', 'Employment types that may borrow (comma-separated)'),
  ('loans.min_service_months', '12', 'number', 'loans', 'Months of service before an employee may borrow'),
  ('loans.max_salary_multiple', '2', 'number', 'loans', 'Most an employee may borrow, in months of basic salary'),
  ('loans.min_amount', '1000', 'number', 'loans', 'Smallest loan (pesos)'),
  ('loans.terms', '3,6,12', 'string', 'loans', 'Repayment terms offered, in months (comma-separated)'),
  ('loans.interest_rate_monthly', '0.01', 'number', 'loans', 'Add-on interest per month (0.01 = 1%)'),
  ('loans.max_deduction_percent', '25', 'number', 'loans', 'Largest payday deduction, as a percent of the payday basic pay');

INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('self.loans', 'self', 'Apply for a salary loan and follow its repayment'),
  ('loans.approve', 'payroll', 'Approve or reject salary loan applications'),
  ('loans.release', 'payroll', 'Release approved salary loans');

-- Accounting Staff and Payroll Staff decide employees' requests (the supervisor keeps every grant it has)
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
    ON (r.code IN ('payroll_staff', 'accounting_staff') AND p.code IN (
          'leave.view', 'leave.review', 'attendance.view', 'attendance.correction.review', 'overtime.approve', 'bank.review',
          'statutory.review', 'benefits.review', 'retirement.manage', 'retirement.approve', 'leave.conversion.review', 'loans.approve'))
    OR (r.code IN ('payroll_staff', 'accounting_supervisor') AND p.code = 'loans.release')
    OR (r.code = 'accounting_supervisor' AND p.code = 'loans.approve')
    OR (r.code IN ('employee', 'payroll_staff', 'accounting_staff', 'accounting_supervisor') AND p.code = 'self.loans');
