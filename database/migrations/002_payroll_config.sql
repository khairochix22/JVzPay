-- 002: payroll configuration (components, statutory rules, tax table, periods, holidays, recurring pay items)
-- Statutory values are DATA with effective dates, never code constants.

CREATE TABLE salary_components (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(40)  NOT NULL,
  name           VARCHAR(120) NOT NULL,
  component_type ENUM('earning','deduction') NOT NULL,
  category       ENUM('basic','overtime','holiday','night_diff','allowance','incentive','bonus','other_earning',
                      'statutory','tax','loan','absence','other_deduction') NOT NULL,
  is_taxable     TINYINT(1) NOT NULL DEFAULT 1,
  is_system      TINYINT(1) NOT NULL DEFAULT 0,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_comp_code (code)
) ENGINE=InnoDB;

CREATE TABLE holidays (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  holiday_date DATE NOT NULL,
  name         VARCHAR(120) NOT NULL,
  holiday_type ENUM('regular','special_non_working','special_working') NOT NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_holiday_date (holiday_date)
) ENGINE=InnoDB;

-- Employee/employer shares are fractions of the (clamped, optionally rounded) monthly compensation base.
CREATE TABLE statutory_contribution_rules (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agency             ENUM('SSS','PHILHEALTH','PAGIBIG') NOT NULL,
  effective_from     DATE NOT NULL,
  effective_to       DATE NULL,
  employee_rate      DECIMAL(8,6) NOT NULL,
  employer_rate      DECIMAL(8,6) NOT NULL,
  salary_floor       DECIMAL(12,2) NOT NULL DEFAULT 0,       -- base is raised to this minimum
  salary_ceiling     DECIMAL(12,2) NOT NULL,                 -- base is capped at this maximum
  rounding_step      DECIMAL(8,2)  NOT NULL DEFAULT 0,       -- 0 = none (SSS credits round to nearest step)
  ec_threshold       DECIMAL(12,2) NOT NULL DEFAULT 0,       -- employer EC contribution (SSS): low/high split
  ec_amount_low      DECIMAL(10,2) NOT NULL DEFAULT 0,
  ec_amount_high     DECIMAL(10,2) NOT NULL DEFAULT 0,
  source_reference   VARCHAR(255) NULL,
  notes              VARCHAR(500) NULL,
  is_verified        TINYINT(1) NOT NULL DEFAULT 0,
  verified_by        BIGINT UNSIGNED NULL,
  verified_at        DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_scr_lookup (agency, effective_from),
  CONSTRAINT fk_scr_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_scr_rates  CHECK (employee_rate >= 0 AND employer_rate >= 0),
  CONSTRAINT chk_scr_bounds CHECK (salary_ceiling >= salary_floor)
) ENGINE=InnoDB;

-- Annual graduated table: tax = base_tax + rate * (annual_taxable - annual_from)
CREATE TABLE withholding_tax_brackets (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  effective_from   DATE NOT NULL,
  effective_to     DATE NULL,
  annual_from      DECIMAL(14,2) NOT NULL,
  annual_to        DECIMAL(14,2) NULL,                       -- NULL = no upper limit
  base_tax         DECIMAL(14,2) NOT NULL DEFAULT 0,
  rate             DECIMAL(6,4)  NOT NULL,
  source_reference VARCHAR(255) NULL,
  is_verified      TINYINT(1) NOT NULL DEFAULT 0,
  verified_by      BIGINT UNSIGNED NULL,
  verified_at      DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_wtb_lookup (effective_from, annual_from),
  CONSTRAINT fk_wtb_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE payroll_periods (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(40)  NOT NULL,
  label         VARCHAR(120) NOT NULL,
  pay_frequency ENUM('weekly','semi_monthly','monthly') NOT NULL,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  pay_date      DATE NULL,
  status        ENUM('open','locked','closed') NOT NULL DEFAULT 'open',
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_period_code (code),
  UNIQUE KEY uq_period_range (pay_frequency, start_date, end_date),
  CONSTRAINT fk_period_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_period_dates CHECK (end_date >= start_date)
) ENGINE=InnoDB;

-- Recurring allowances / deductions / loans per employee. Deductions & loans need supervisor approval.
CREATE TABLE employee_pay_items (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id       BIGINT UNSIGNED NOT NULL,
  component_id      BIGINT UNSIGNED NOT NULL,
  description       VARCHAR(200) NULL,
  amount            DECIMAL(12,2) NOT NULL,                  -- per payroll period
  remaining_balance DECIMAL(12,2) NULL,                      -- loans / advances: stops at 0
  effective_from    DATE NOT NULL,
  effective_to      DATE NULL,
  status            ENUM('pending','approved','rejected','ended') NOT NULL DEFAULT 'pending',
  submitted_by      BIGINT UNSIGNED NULL,
  decided_by        BIGINT UNSIGNED NULL,
  decided_at        DATETIME NULL,
  decision_remarks  VARCHAR(255) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_epi_emp (employee_id, status),
  CONSTRAINT fk_epi_emp  FOREIGN KEY (employee_id)  REFERENCES employees (id),
  CONSTRAINT fk_epi_comp FOREIGN KEY (component_id) REFERENCES salary_components (id),
  CONSTRAINT fk_epi_sub  FOREIGN KEY (submitted_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_epi_dec  FOREIGN KEY (decided_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_epi_amount CHECK (amount >= 0 AND (remaining_balance IS NULL OR remaining_balance >= 0))
) ENGINE=InnoDB;
