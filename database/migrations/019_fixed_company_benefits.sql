-- Owner's benefit policy, 2026-11-13: the company offers two fixed benefits.
--  * HMO: Cocolife, ₱250,000 coverage, covering up to 3 dependents who must be immediate family (spouse, child, parent).
--  * Life and accident insurance, combined in one plan from a fixed provider; the employee names up to 2 beneficiaries,
--    a spouse or a family member.
-- Provider names, the coverage and the limits are in System Settings (benefits.*). Older free-text enrollments are kept.
-- Also: 13th-month pay and other bonuses are tax-exempt up to ₱90,000 a year (TRAIN law); only the excess is taxable.

ALTER TABLE benefit_enrollment_references
  MODIFY benefit_type ENUM('hmo','life_insurance','accident_insurance','other','life_accident') NOT NULL,
  ADD COLUMN coverage_amount DECIMAL(14,2) NULL AFTER plan_name;

-- the verified dependents an HMO enrollment covers
CREATE TABLE benefit_covered_dependents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  enrollment_id BIGINT UNSIGNED NOT NULL,
  dependent_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bcd (enrollment_id, dependent_id),
  CONSTRAINT fk_bcd_enr FOREIGN KEY (enrollment_id) REFERENCES benefit_enrollment_references (id) ON DELETE CASCADE,
  CONSTRAINT fk_bcd_dep FOREIGN KEY (dependent_id) REFERENCES dependent_enrollments (id)
) ENGINE=InnoDB;

-- the beneficiaries of a life and accident insurance enrollment
CREATE TABLE benefit_beneficiaries (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  enrollment_id BIGINT UNSIGNED NOT NULL,
  full_name     VARCHAR(160) NOT NULL,
  relationship  ENUM('spouse','child','parent','sibling') NOT NULL,
  birth_date    DATE NULL,
  share_percent DECIMAL(5,2) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_bb_enr (enrollment_id),
  CONSTRAINT fk_bb_enr FOREIGN KEY (enrollment_id) REFERENCES benefit_enrollment_references (id) ON DELETE CASCADE,
  CONSTRAINT chk_bb_share CHECK (share_percent > 0 AND share_percent <= 100)
) ENGINE=InnoDB;

INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES
  ('benefits.hmo_provider', 'Cocolife', 'string', 'benefits', 'Company HMO provider'),
  ('benefits.hmo_coverage', '250000', 'number', 'benefits', 'HMO coverage per member (pesos)'),
  ('benefits.hmo_max_dependents', '3', 'number', 'benefits', 'Dependents an HMO enrollment can cover (immediate family only)'),
  ('benefits.insurance_provider', 'Insulife — Pru Life UK', 'string', 'benefits', 'Life and accident insurance provider'),
  ('benefits.insurance_max_beneficiaries', '2', 'number', 'benefits', 'Beneficiaries per life and accident insurance enrollment'),
  ('payroll.bonus_tax_exempt_ceiling', '90000', 'number', 'payroll', '13th-month pay and other bonuses tax-exempt per year (TRAIN law); the excess is taxable');
