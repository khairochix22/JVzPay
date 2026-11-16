-- 023: position-based compensation bands and allowance packages
-- National Philippine private-sector planning benchmarks; HR must validate offers against
-- the actual job scope, experience, location, and current labor-market data.

CREATE TABLE IF NOT EXISTS position_compensation_bands (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  position_id         BIGINT UNSIGNED NOT NULL,
  effective_from      DATE NOT NULL,
  effective_to        DATE NULL,
  currency            CHAR(3) NOT NULL DEFAULT 'PHP',
  minimum_monthly     DECIMAL(12,2) NOT NULL,
  midpoint_monthly    DECIMAL(12,2) NOT NULL,
  maximum_monthly     DECIMAL(12,2) NOT NULL,
  rate_basis          ENUM('monthly','daily','hourly') NOT NULL DEFAULT 'monthly',
  enforcement         ENUM('flag','block','recommend_only') NOT NULL DEFAULT 'flag',
  benchmark_basis     VARCHAR(255) NOT NULL,
  review_notes        VARCHAR(500) NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pcb_position_effective (position_id, effective_from),
  KEY ix_pcb_lookup (position_id, is_active, effective_from),
  CONSTRAINT fk_pcb_position FOREIGN KEY (position_id) REFERENCES positions (id),
  CONSTRAINT chk_pcb_range CHECK (minimum_monthly >= 0 AND minimum_monthly <= midpoint_monthly AND midpoint_monthly <= maximum_monthly)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS position_allowance_packages (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  position_id         BIGINT UNSIGNED NOT NULL,
  effective_from      DATE NOT NULL,
  effective_to        DATE NULL,
  allowance_code      VARCHAR(40) NOT NULL,
  allowance_name      VARCHAR(120) NOT NULL,
  amount              DECIMAL(12,2) NOT NULL,
  frequency           ENUM('monthly','annual','per_payday','per_day') NOT NULL DEFAULT 'monthly',
  taxable             TINYINT(1) NOT NULL DEFAULT 1,
  de_minimis_cap      DECIMAL(12,2) NULL,
  eligibility_note    VARCHAR(255) NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pap_line (position_id, effective_from, allowance_code),
  KEY ix_pap_lookup (position_id, is_active, effective_from),
  CONSTRAINT fk_pap_position FOREIGN KEY (position_id) REFERENCES positions (id),
  CONSTRAINT chk_pap_amount CHECK (amount >= 0 AND (de_minimis_cap IS NULL OR de_minimis_cap >= 0))
) ENGINE=InnoDB;

-- These are planning bands for a national private-company market, not legal minimums
-- and not a promise that every employee will receive the midpoint.
INSERT INTO position_compensation_bands
  (position_id, effective_from, minimum_monthly, midpoint_monthly, maximum_monthly, benchmark_basis, review_notes)
SELECT p.id, '2026-11-13', v.minimum_monthly, v.midpoint_monthly, v.maximum_monthly,
       '2026 Philippine private-sector directional benchmark; validate by scope, experience, and location',
       'HR review at least annually and whenever the role scope changes'
FROM positions p
JOIN (
  SELECT 'Store Manager' title, 35000 minimum_monthly, 45000 midpoint_monthly, 60000 maximum_monthly
  UNION ALL SELECT 'Payroll Supervisor', 28000, 36000, 45000
  UNION ALL SELECT 'Payroll Staff', 18000, 24000, 30000
  UNION ALL SELECT 'Demo Position', 15000, 17500, 22000
  UNION ALL SELECT 'CRM Manager', 35000, 45000, 60000
  UNION ALL SELECT 'Team Leader', 25000, 32000, 40000
  UNION ALL SELECT 'Agent', 16000, 21000, 28000
  UNION ALL SELECT 'HR Super Admin', 40000, 52000, 70000
  UNION ALL SELECT 'HR Supervisor', 28000, 36000, 45000
  UNION ALL SELECT 'HR Staff', 18000, 24000, 32000
  UNION ALL SELECT 'Inventory Manager', 30000, 40000, 55000
  UNION ALL SELECT 'Inventory Supervisor', 24000, 30000, 38000
  UNION ALL SELECT 'Inventory Staff', 16000, 21000, 28000
  UNION ALL SELECT 'Accounting Supervisor', 35000, 45000, 60000
  UNION ALL SELECT 'Accounting Staff', 20000, 26000, 34000
  UNION ALL SELECT 'Employee (ESS)', 15000, 18000, 22000
) v ON v.title = p.title
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM position_compensation_bands b
    WHERE b.position_id = p.id AND b.effective_from = '2026-11-13'
  );

-- Allowance package defaults. Rice and clothing follow the 2026 de minimis ceilings;
-- transport and communication are taxable planning allowances unless HR documents a
-- qualifying business reimbursement policy.
INSERT INTO position_allowance_packages
  (position_id, effective_from, allowance_code, allowance_name, amount, frequency, taxable, de_minimis_cap, eligibility_note)
SELECT p.id, '2026-11-13', a.allowance_code, a.allowance_name, a.amount, a.frequency, a.taxable, a.de_minimis_cap, a.eligibility_note
FROM positions p
JOIN (
  SELECT 'Store Manager' title, 'RICE' allowance_code, 'Rice subsidy' allowance_name, 2500 amount, 'monthly' frequency, 0 taxable, 2500 de_minimis_cap, 'All active employees' AS eligibility_note
  UNION ALL SELECT 'Store Manager', 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'Store Manager', 'TRANSPORT', 'Transportation allowance', 4000, 'monthly', 1, NULL, 'Role-related travel or commute support'
  UNION ALL SELECT 'Store Manager', 'COMMUNICATION', 'Communication allowance', 1500, 'monthly', 1, NULL, 'Business calls and data'
  UNION ALL SELECT 'Payroll Supervisor', 'RICE', 'Rice subsidy', 2500, 'monthly', 0, 2500, 'All active employees'
  UNION ALL SELECT 'Payroll Supervisor', 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'Payroll Supervisor', 'TRANSPORT', 'Transportation allowance', 2500, 'monthly', 1, NULL, 'Role-related travel or commute support'
  UNION ALL SELECT 'Payroll Supervisor', 'COMMUNICATION', 'Communication allowance', 1000, 'monthly', 1, NULL, 'Business calls and data'
  UNION ALL SELECT 'Payroll Staff', 'RICE', 'Rice subsidy', 2500, 'monthly', 0, 2500, 'All active employees'
  UNION ALL SELECT 'Payroll Staff', 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'Payroll Staff', 'TRANSPORT', 'Transportation allowance', 1500, 'monthly', 1, NULL, 'Role-related travel or commute support'
  UNION ALL SELECT 'Payroll Staff', 'COMMUNICATION', 'Communication allowance', 500, 'monthly', 1, NULL, 'Business calls and data'
  UNION ALL SELECT 'Demo Position', 'RICE', 'Rice subsidy', 2500, 'monthly', 0, 2500, 'All active employees'
  UNION ALL SELECT 'Demo Position', 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'Demo Position', 'TRANSPORT', 'Transportation allowance', 1200, 'monthly', 1, NULL, 'Role-related travel or commute support'
  UNION ALL SELECT 'CRM Manager', 'RICE', 'Rice subsidy', 2500, 'monthly', 0, 2500, 'All active employees'
  UNION ALL SELECT 'CRM Manager', 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'CRM Manager', 'TRANSPORT', 'Transportation allowance', 3500, 'monthly', 1, NULL, 'Role-related travel or commute support'
  UNION ALL SELECT 'CRM Manager', 'COMMUNICATION', 'Communication allowance', 1500, 'monthly', 1, NULL, 'Business calls and data'
  UNION ALL SELECT 'Team Leader', 'RICE', 'Rice subsidy', 2500, 'monthly', 0, 2500, 'All active employees'
  UNION ALL SELECT 'Team Leader', 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'Team Leader', 'TRANSPORT', 'Transportation allowance', 2500, 'monthly', 1, NULL, 'Role-related travel or commute support'
  UNION ALL SELECT 'Team Leader', 'COMMUNICATION', 'Communication allowance', 1000, 'monthly', 1, NULL, 'Business calls and data'
  UNION ALL SELECT 'Agent', 'RICE', 'Rice subsidy', 2500, 'monthly', 0, 2500, 'All active employees'
  UNION ALL SELECT 'Agent', 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'Agent', 'TRANSPORT', 'Transportation allowance', 1500, 'monthly', 1, NULL, 'Role-related travel or commute support'
  UNION ALL SELECT 'Agent', 'COMMUNICATION', 'Communication allowance', 500, 'monthly', 1, NULL, 'Business calls and data'
) a ON a.title = p.title
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM position_allowance_packages x
    WHERE x.position_id = p.id AND x.effective_from = '2026-11-13' AND x.allowance_code = a.allowance_code
  );

-- Copy the standard package to the remaining office and operations positions.
INSERT INTO position_allowance_packages
  (position_id, effective_from, allowance_code, allowance_name, amount, frequency, taxable, de_minimis_cap, eligibility_note)
SELECT p.id, '2026-11-13', a.allowance_code, a.allowance_name, a.amount, a.frequency, a.taxable, a.de_minimis_cap, a.eligibility_note
FROM positions p
JOIN (
  SELECT 'RICE' allowance_code, 'Rice subsidy' allowance_name, 2500 amount, 'monthly' frequency, 0 taxable, 2500 de_minimis_cap, 'All active employees' AS eligibility_note
  UNION ALL SELECT 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'TRANSPORT', 'Transportation allowance', 1500, 'monthly', 1, NULL, 'Role-related travel or commute support'
) a
WHERE p.deleted_at IS NULL
  AND p.title IN ('HR Super Admin', 'HR Supervisor', 'HR Staff', 'Inventory Manager', 'Inventory Supervisor', 'Inventory Staff', 'Accounting Supervisor', 'Accounting Staff', 'Employee (ESS)')
  AND NOT EXISTS (
    SELECT 1 FROM position_allowance_packages x
    WHERE x.position_id = p.id AND x.effective_from = '2026-11-13' AND x.allowance_code = a.allowance_code
  );
