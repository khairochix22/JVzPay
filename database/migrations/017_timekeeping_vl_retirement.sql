-- Owner's request, 2026-11-13:
--  1. Time clock: employees punch morning in, morning break (start and end, 15 minutes), morning out, afternoon in,
--     afternoon break (start and end, 15 minutes) and afternoon out; lunch is one hour. A break counts only when punched.
--  2. Weekly schedules: five work days and two days off per employee (default Monday to Friday, Saturday and Sunday off).
--  3. Approved overtime appears on the employee's schedule (overtime_records already has start and end times since 016).
--  4. Vacation leave: 10 days a year, reset every 1 January; the unused balance can be converted to cash at year end.
--  5. Retirement fund: the employee contributes 10, 15 or 20 percent of the basic monthly salary every payday and the
--     company adds the same amount. After 25 years of service everything can be withdrawn; before that only the
--     employee's own share, and the company share is forfeited.

-- ------------------------------------------------------------------ 1–2. schedules and punches
CREATE TABLE work_schedules (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id     BIGINT UNSIGNED NOT NULL,
  effective_from  DATE NOT NULL,
  rest_day_1      TINYINT UNSIGNED NOT NULL,
  rest_day_2      TINYINT UNSIGNED NOT NULL,
  shift_start     TIME NOT NULL,
  lunch_start     TIME NOT NULL,
  lunch_end       TIME NOT NULL,
  shift_end       TIME NOT NULL,
  remarks         VARCHAR(255) NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ws_emp_from (employee_id, effective_from),
  CONSTRAINT fk_ws_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_ws_cre FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_ws_rest CHECK (rest_day_1 <= 6 AND rest_day_2 <= 6 AND rest_day_1 <> rest_day_2),
  CONSTRAINT chk_ws_times CHECK (shift_start < lunch_start AND lunch_start < lunch_end AND lunch_end < shift_end)
) ENGINE=InnoDB;

CREATE TABLE attendance_punches (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id  BIGINT UNSIGNED NOT NULL,
  work_date    DATE NOT NULL,
  punch_type   ENUM('am_in','am_break_start','am_break_end','am_out','pm_in','pm_break_start','pm_break_end','pm_out') NOT NULL,
  punched_at   DATETIME NOT NULL,
  ip_address   VARCHAR(45) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_punch (employee_id, work_date, punch_type),
  KEY ix_punch_date (work_date),
  CONSTRAINT fk_punch_emp FOREIGN KEY (employee_id) REFERENCES employees (id)
) ENGINE=InnoDB;

ALTER TABLE attendance_records MODIFY source ENUM('manual','correction','leave','import','punch') NOT NULL DEFAULT 'manual';

-- ------------------------------------------------------------------ 4. vacation leave conversion
ALTER TABLE leave_types ADD COLUMN convertible_to_cash TINYINT(1) NOT NULL DEFAULT 0 AFTER allow_negative_balance;
UPDATE leave_types SET annual_entitlement_days = 10, convertible_to_cash = 1 WHERE code = 'VL';
UPDATE leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
   SET b.entitled_days = 10
 WHERE t.code = 'VL' AND b.year >= YEAR(CURDATE()) AND b.entitled_days < 10;

CREATE TABLE leave_conversions (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversion_no     VARCHAR(30) NOT NULL,
  employee_id       BIGINT UNSIGNED NOT NULL,
  leave_type_id     BIGINT UNSIGNED NOT NULL,
  year              SMALLINT UNSIGNED NOT NULL,
  days              DECIMAL(5,1) NOT NULL,
  daily_rate        DECIMAL(12,2) NOT NULL,
  amount            DECIMAL(14,2) NOT NULL,
  status            ENUM('pending','approved','rejected','cancelled','paid') NOT NULL DEFAULT 'pending',
  active_flag       TINYINT(1) NULL DEFAULT 1,
  requested_by      BIGINT UNSIGNED NOT NULL,
  requested_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by        BIGINT UNSIGNED NULL,
  decided_at        DATETIME NULL,
  decision_remarks  VARCHAR(500) NULL,
  payroll_record_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lc_no (conversion_no),
  UNIQUE KEY uq_lc_one (employee_id, leave_type_id, year, active_flag),
  KEY ix_lc_status (status),
  CONSTRAINT fk_lc_emp  FOREIGN KEY (employee_id)       REFERENCES employees (id),
  CONSTRAINT fk_lc_type FOREIGN KEY (leave_type_id)     REFERENCES leave_types (id),
  CONSTRAINT fk_lc_req  FOREIGN KEY (requested_by)      REFERENCES users (id),
  CONSTRAINT fk_lc_dec  FOREIGN KEY (decided_by)        REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_lc_rec  FOREIGN KEY (payroll_record_id) REFERENCES payroll_records (id) ON DELETE SET NULL,
  CONSTRAINT chk_lc_days CHECK (days > 0 AND amount >= 0)
) ENGINE=InnoDB;

-- ------------------------------------------------------------------ 5. retirement fund
CREATE TABLE retirement_enrollments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id    BIGINT UNSIGNED NOT NULL,
  rate_percent   TINYINT UNSIGNED NOT NULL,
  status         ENUM('active','changed','stopped','withdrawn') NOT NULL DEFAULT 'active',
  active_flag    TINYINT(1) NULL DEFAULT 1,
  effective_from DATE NOT NULL,
  ended_at       DATETIME NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_re_active (employee_id, active_flag),
  CONSTRAINT fk_re_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_re_cre FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_re_rate CHECK (rate_percent IN (10, 15, 20))
) ENGINE=InnoDB;

CREATE TABLE retirement_withdrawals (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  withdrawal_no       VARCHAR(30) NOT NULL,
  employee_id         BIGINT UNSIGNED NOT NULL,
  reason              ENUM('retirement','resigned','terminated','voluntary') NOT NULL,
  remarks             VARCHAR(500) NULL,
  tenure_years        DECIMAL(5,2) NOT NULL,
  vested              TINYINT(1) NOT NULL DEFAULT 0,
  employee_share      DECIMAL(14,2) NOT NULL DEFAULT 0,
  company_share       DECIMAL(14,2) NOT NULL DEFAULT 0,
  payable_amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  forfeited_amount    DECIMAL(14,2) NOT NULL DEFAULT 0,
  status              ENUM('pending','approved','rejected','cancelled','paid') NOT NULL DEFAULT 'pending',
  requested_by        BIGINT UNSIGNED NOT NULL,
  requested_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by          BIGINT UNSIGNED NULL,
  decided_at          DATETIME NULL,
  decision_remarks    VARCHAR(500) NULL,
  paid_by             BIGINT UNSIGNED NULL,
  paid_at             DATETIME NULL,
  payment_reference   VARCHAR(100) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rw_no (withdrawal_no),
  KEY ix_rw_emp (employee_id, status),
  CONSTRAINT fk_rw_emp  FOREIGN KEY (employee_id)  REFERENCES employees (id),
  CONSTRAINT fk_rw_req  FOREIGN KEY (requested_by) REFERENCES users (id),
  CONSTRAINT fk_rw_dec  FOREIGN KEY (decided_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_rw_paid FOREIGN KEY (paid_by)      REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_rw_split CHECK (payable_amount + forfeited_amount = employee_share + company_share)
) ENGINE=InnoDB;

-- one row per finalized payroll record; removed again if that payroll is voided
CREATE TABLE retirement_contributions (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id       BIGINT UNSIGNED NOT NULL,
  enrollment_id     BIGINT UNSIGNED NOT NULL,
  payroll_record_id BIGINT UNSIGNED NOT NULL,
  period_id         BIGINT UNSIGNED NOT NULL,
  rate_percent      TINYINT UNSIGNED NOT NULL,
  employee_share    DECIMAL(14,2) NOT NULL,
  company_share     DECIMAL(14,2) NOT NULL,
  contribution_date DATE NOT NULL,
  withdrawal_id     BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rc_record (payroll_record_id),
  KEY ix_rc_emp (employee_id, withdrawal_id),
  CONSTRAINT fk_rc_emp FOREIGN KEY (employee_id)       REFERENCES employees (id),
  CONSTRAINT fk_rc_enr FOREIGN KEY (enrollment_id)     REFERENCES retirement_enrollments (id),
  CONSTRAINT fk_rc_rec FOREIGN KEY (payroll_record_id) REFERENCES payroll_records (id),
  CONSTRAINT fk_rc_per FOREIGN KEY (period_id)         REFERENCES payroll_periods (id),
  CONSTRAINT fk_rc_wd  FOREIGN KEY (withdrawal_id)     REFERENCES retirement_withdrawals (id),
  CONSTRAINT chk_rc_amt CHECK (employee_share >= 0 AND company_share >= 0)
) ENGINE=InnoDB;

ALTER TABLE payroll_records ADD COLUMN retirement_company_share DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER employer_contributions;
ALTER TABLE salary_components MODIFY category ENUM('basic','overtime','holiday','night_diff','allowance','incentive','bonus','other_earning',
  'statutory','tax','loan','absence','other_deduction','retirement') NOT NULL;

INSERT IGNORE INTO salary_components (code, name, component_type, category, is_taxable, is_system) VALUES
  ('RETIREMENT', 'Retirement Fund Contribution', 'deduction', 'retirement', 0, 1),
  ('LEAVE_CONV', 'Vacation Leave Conversion', 'earning', 'other_earning', 0, 1);

INSERT IGNORE INTO chart_of_accounts (code, name, account_type, normal_balance, is_cash, is_system) VALUES
  ('2250', 'Retirement Fund Payable', 'liability', 'credit', 0, 1),
  ('2260', 'Retirement Withdrawals Payable', 'liability', 'credit', 0, 1),
  ('4040', 'Forfeited Retirement Contributions', 'revenue', 'credit', 0, 1),
  ('5060', 'Retirement Fund Expense', 'expense', 'debit', 0, 1);

-- ------------------------------------------------------------------ settings
INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES
  ('attendance.rest_day_2', '6', 'number', 'attendance', 'Second weekly day off (0=Sunday … 6=Saturday) for employees without their own schedule'),
  ('attendance.lunch_start', '12:00', 'time', 'attendance', 'Standard lunch start (lunch is one hour)'),
  ('attendance.short_break_minutes', '15', 'number', 'attendance', 'Paid morning and afternoon break (minutes each; counted only when punched)'),
  ('retirement.vesting_years', '25', 'number', 'retirement', 'Years of service before the company share of the retirement fund can be withdrawn');
-- five work days a week: the daily rate of a monthly salary uses 261 working days a year (only if still the 6-day default)
UPDATE system_settings SET setting_value = '261', description = 'Days/year used to derive a daily rate from a monthly salary (261 = 5-day week)'
 WHERE setting_key = 'payroll.days_per_year' AND setting_value = '313';

-- ------------------------------------------------------------------ permissions
INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('schedules.manage', 'attendance', 'Assign employees'' work schedules and days off'),
  ('leave.conversion.review', 'leave', 'Approve or reject vacation leave cash conversions'),
  ('retirement.manage', 'payroll', 'View the retirement fund, file withdrawals for separated employees and record payouts'),
  ('retirement.approve', 'payroll', 'Approve or reject retirement fund withdrawals'),
  ('self.retirement', 'self', 'Enroll in the retirement fund and request withdrawals');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
    ON (r.code = 'accounting_supervisor' AND p.code IN ('schedules.manage', 'leave.conversion.review', 'retirement.manage', 'retirement.approve', 'self.retirement'))
    OR (r.code = 'payroll_staff' AND p.code IN ('schedules.manage', 'retirement.manage', 'self.retirement'))
    OR (r.code IN ('employee', 'accounting_staff') AND p.code = 'self.retirement');
