-- Employee Self-Service additions (master prompt §V): government enrollment, dependents and benefits enrollment.
-- Employees submit; Payroll Staff verify (statutory.review / benefits.review); nobody decides on their own request.
-- Government numbers are encrypted (AES-256-GCM in the app) and shown masked.

CREATE TABLE statutory_enrollments (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_no        VARCHAR(30) NOT NULL,
  employee_id       BIGINT UNSIGNED NOT NULL,
  sss_no_enc        VARCHAR(255) NULL,
  philhealth_no_enc VARCHAR(255) NULL,
  pagibig_no_enc    VARCHAR(255) NULL,
  tin_enc           VARCHAR(255) NULL,
  attachment_id     BIGINT UNSIGNED NULL,
  status            ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  submitted_by      BIGINT UNSIGNED NOT NULL,
  submitted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by        BIGINT UNSIGNED NULL,
  decided_at        DATETIME NULL,
  decision_remarks  VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_se_no (request_no),
  KEY ix_se_emp (employee_id, status),
  KEY ix_se_status (status, submitted_at),
  CONSTRAINT fk_se_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_se_doc FOREIGN KEY (attachment_id) REFERENCES document_attachments (id) ON DELETE SET NULL,
  CONSTRAINT fk_se_sub FOREIGN KEY (submitted_by) REFERENCES users (id),
  CONSTRAINT fk_se_dec FOREIGN KEY (decided_by) REFERENCES users (id),
  CONSTRAINT chk_se_any CHECK (sss_no_enc IS NOT NULL OR philhealth_no_enc IS NOT NULL OR pagibig_no_enc IS NOT NULL OR tin_enc IS NOT NULL),
  CONSTRAINT chk_se_reject CHECK (status <> 'rejected' OR (decision_remarks IS NOT NULL AND decision_remarks <> ''))
) ENGINE=InnoDB;

CREATE TABLE dependent_enrollments (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_no        VARCHAR(30) NOT NULL,
  employee_id       BIGINT UNSIGNED NOT NULL,
  full_name         VARCHAR(160) NOT NULL,
  relationship      ENUM('spouse','child','parent','sibling','other') NOT NULL,
  birth_date        DATE NOT NULL,
  remarks           VARCHAR(255) NULL,
  attachment_id     BIGINT UNSIGNED NULL,
  status            ENUM('pending','approved','rejected','cancelled','removed') NOT NULL DEFAULT 'pending',
  submitted_by      BIGINT UNSIGNED NOT NULL,
  submitted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by        BIGINT UNSIGNED NULL,
  decided_at        DATETIME NULL,
  decision_remarks  VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_de_no (request_no),
  KEY ix_de_emp (employee_id, status),
  KEY ix_de_status (status, submitted_at),
  CONSTRAINT fk_de_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_de_doc FOREIGN KEY (attachment_id) REFERENCES document_attachments (id) ON DELETE SET NULL,
  CONSTRAINT fk_de_sub FOREIGN KEY (submitted_by) REFERENCES users (id),
  CONSTRAINT fk_de_dec FOREIGN KEY (decided_by) REFERENCES users (id),
  CONSTRAINT chk_de_reject CHECK (status <> 'rejected' OR (decision_remarks IS NOT NULL AND decision_remarks <> ''))
) ENGINE=InnoDB;

CREATE TABLE benefit_enrollment_references (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_no        VARCHAR(30) NOT NULL,
  employee_id       BIGINT UNSIGNED NOT NULL,
  benefit_type      ENUM('hmo','life_insurance','accident_insurance','other') NOT NULL,
  plan_name         VARCHAR(120) NOT NULL,
  dependents_count  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  remarks           VARCHAR(255) NULL,
  attachment_id     BIGINT UNSIGNED NULL,
  status            ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  submitted_by      BIGINT UNSIGNED NOT NULL,
  submitted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by        BIGINT UNSIGNED NULL,
  decided_at        DATETIME NULL,
  decision_remarks  VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_be_no (request_no),
  KEY ix_be_emp (employee_id, status),
  KEY ix_be_status (status, submitted_at),
  CONSTRAINT fk_be_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_be_doc FOREIGN KEY (attachment_id) REFERENCES document_attachments (id) ON DELETE SET NULL,
  CONSTRAINT fk_be_sub FOREIGN KEY (submitted_by) REFERENCES users (id),
  CONSTRAINT fk_be_dec FOREIGN KEY (decided_by) REFERENCES users (id),
  CONSTRAINT chk_be_reject CHECK (status <> 'rejected' OR (decision_remarks IS NOT NULL AND decision_remarks <> ''))
) ENGINE=InnoDB;

-- which employment types may enroll in company benefits (editable in System Settings)
INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES
  ('benefits.eligible_types', 'regular', 'string', 'benefits', 'Employment types eligible for company benefits (comma-separated: regular, probationary, contractual, part_time, seasonal)');

INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('statutory.review', 'self', 'Verify employees'' government enrollment numbers'),
  ('benefits.review', 'self', 'Verify dependents and benefit enrollments'),
  ('self.enrollments', 'self', 'Submit own government enrollment, dependents and benefits');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('statutory.review', 'benefits.review') WHERE r.code IN ('payroll_staff', 'accounting_supervisor');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'self.enrollments' WHERE r.code IN ('employee', 'payroll_staff', 'accounting_staff', 'accounting_supervisor');
