-- Employee account registration (owner's flow, 2026-11-13; master prompt §IV). HR encodes the new hire with a personal
-- email, department and position, and generates the Employee ID and a unique code. The new hire registers in JVzPay with
-- those details and a password; when everything matches HR's record the account is activated at once and opens only the
-- employee's own department. One row per registration; the password itself lives only in users.
CREATE TABLE employee_verification_records (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id            BIGINT UNSIGNED NOT NULL,
  hr_employee_id         VARCHAR(40)  NULL,
  employee_no            VARCHAR(20)  NOT NULL,
  full_name              VARCHAR(160) NOT NULL,
  department_name        VARCHAR(100) NOT NULL,
  position_title         VARCHAR(100) NOT NULL,
  email                  VARCHAR(190) NOT NULL,
  password_hash          VARCHAR(100) NOT NULL,          -- bcrypt; becomes the account password; erased once decided
  hr_check               ENUM('hr_api','hr_snapshot') NOT NULL,
  status                 ENUM('pending_email','pending_activation','activated','rejected','expired') NOT NULL,
  email_code_hash        CHAR(64) NULL,
  email_code_expires_at  DATETIME NULL,
  email_code_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  email_verified_at      DATETIME NULL,
  user_id                BIGINT UNSIGNED NULL,
  decided_by             BIGINT UNSIGNED NULL,
  decided_at             DATETIME NULL,
  decision_remarks       VARCHAR(500) NULL,
  privacy_ack_version    VARCHAR(20) NULL,
  ip_address             VARCHAR(45) NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_evr_emp (employee_id, status),
  KEY ix_evr_status (status, created_at),
  KEY ix_evr_email (email),
  CONSTRAINT fk_evr_emp     FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_evr_user    FOREIGN KEY (user_id)     REFERENCES users (id),
  CONSTRAINT fk_evr_decider FOREIGN KEY (decided_by)  REFERENCES users (id),
  CONSTRAINT chk_evr_reject CHECK (status <> 'rejected' OR (decision_remarks IS NOT NULL AND decision_remarks <> ''))
) ENGINE=InnoDB;

INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('ess.activate', 'users', 'View employee account registrations');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'ess.activate' WHERE r.code IN ('payroll_staff', 'accounting_supervisor');
