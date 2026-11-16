-- 003: attendance, overtime, leave, bank enrollment
-- Every request table keeps the ORIGINAL submitted values; decisions are logged in a separate *_approvals table.

-- ---------------------------------------------------------------- ATTENDANCE
CREATE TABLE attendance_records (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id       BIGINT UNSIGNED NOT NULL,
  work_date         DATE NOT NULL,
  time_in           TIME NULL,
  time_out          TIME NULL,
  status            ENUM('present','late','absent','half_day','on_leave','holiday','rest_day') NOT NULL DEFAULT 'present',
  late_minutes      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  undertime_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  hours_worked      DECIMAL(5,2) NOT NULL DEFAULT 0,
  source            ENUM('manual','correction','leave','import') NOT NULL DEFAULT 'manual',
  validation_status ENUM('pending','validated','locked') NOT NULL DEFAULT 'pending',
  validated_by      BIGINT UNSIGNED NULL,
  validated_at      DATETIME NULL,
  locked_batch_id   BIGINT UNSIGNED NULL,                     -- FK added in 004 (payroll_batches)
  remarks           VARCHAR(255) NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_att_emp_day (employee_id, work_date),
  KEY ix_att_date (work_date),
  KEY ix_att_validation (validation_status, work_date),
  CONSTRAINT fk_att_emp  FOREIGN KEY (employee_id)  REFERENCES employees (id),
  CONSTRAINT fk_att_val  FOREIGN KEY (validated_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_att_cre  FOREIGN KEY (created_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_att_times CHECK (time_out IS NULL OR time_in IS NULL OR time_out <> time_in)
) ENGINE=InnoDB;

CREATE TABLE attendance_correction_requests (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_no          VARCHAR(30) NOT NULL,
  employee_id         BIGINT UNSIGNED NOT NULL,
  attendance_id       BIGINT UNSIGNED NULL,
  work_date           DATE NOT NULL,
  original_time_in    TIME NULL,
  original_time_out   TIME NULL,
  original_status     VARCHAR(20) NULL,
  requested_time_in   TIME NULL,
  requested_time_out  TIME NULL,
  requested_status    ENUM('present','late','absent','half_day','on_leave') NOT NULL DEFAULT 'present',
  reason              VARCHAR(500) NOT NULL,
  attachment_id       BIGINT UNSIGNED NULL,
  status              ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  submitted_by        BIGINT UNSIGNED NOT NULL,
  submitted_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by          BIGINT UNSIGNED NULL,
  decided_at          DATETIME NULL,
  decision_remarks    VARCHAR(500) NULL,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_acr_no (request_no),
  KEY ix_acr_emp (employee_id, status),
  KEY ix_acr_status (status, submitted_at),
  CONSTRAINT fk_acr_emp FOREIGN KEY (employee_id)   REFERENCES employees (id),
  CONSTRAINT fk_acr_att FOREIGN KEY (attendance_id) REFERENCES attendance_records (id) ON DELETE SET NULL,
  CONSTRAINT fk_acr_doc FOREIGN KEY (attachment_id) REFERENCES document_attachments (id) ON DELETE SET NULL,
  CONSTRAINT fk_acr_sub FOREIGN KEY (submitted_by)  REFERENCES users (id),
  CONSTRAINT fk_acr_dec FOREIGN KEY (decided_by)    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE attendance_correction_approvals (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id  BIGINT UNSIGNED NOT NULL,
  action      ENUM('approved','rejected') NOT NULL,
  actor_id    BIGINT UNSIGNED NOT NULL,
  actor_role  VARCHAR(40) NOT NULL,
  remarks     VARCHAR(500) NULL,
  decided_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_aca_req (request_id),
  CONSTRAINT fk_aca_req   FOREIGN KEY (request_id) REFERENCES attendance_correction_requests (id),
  CONSTRAINT fk_aca_actor FOREIGN KEY (actor_id)   REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE overtime_records (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id       BIGINT UNSIGNED NOT NULL,
  work_date         DATE NOT NULL,
  hours             DECIMAL(4,2) NOT NULL,
  ot_type           ENUM('regular','rest_day','holiday') NOT NULL DEFAULT 'regular',
  reason            VARCHAR(255) NULL,
  status            ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  submitted_by      BIGINT UNSIGNED NOT NULL,
  submitted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by        BIGINT UNSIGNED NULL,
  decided_at        DATETIME NULL,
  decision_remarks  VARCHAR(255) NULL,
  payroll_record_id BIGINT UNSIGNED NULL,                    -- set once consumed by payroll (FK in 004)
  PRIMARY KEY (id),
  KEY ix_ot_emp_date (employee_id, work_date),
  KEY ix_ot_status (status),
  CONSTRAINT fk_ot_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_ot_sub FOREIGN KEY (submitted_by) REFERENCES users (id),
  CONSTRAINT fk_ot_dec FOREIGN KEY (decided_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_ot_hours CHECK (hours > 0 AND hours <= 24)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- LEAVE
CREATE TABLE leave_types (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                      VARCHAR(20)  NOT NULL,
  name                      VARCHAR(80)  NOT NULL,
  annual_entitlement_days   DECIMAL(5,1) NOT NULL DEFAULT 0,
  is_paid                   TINYINT(1) NOT NULL DEFAULT 1,
  requires_attachment       TINYINT(1) NOT NULL DEFAULT 0,
  attachment_after_days     DECIMAL(4,1) NULL,               -- attachment required when request exceeds N days
  allow_negative_balance    TINYINT(1) NOT NULL DEFAULT 0,
  is_active                 TINYINT(1) NOT NULL DEFAULT 1,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lt_code (code)
) ENGINE=InnoDB;

CREATE TABLE leave_balances (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id   BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  year          SMALLINT UNSIGNED NOT NULL,
  entitled_days DECIMAL(5,1) NOT NULL DEFAULT 0,
  adjusted_days DECIMAL(5,1) NOT NULL DEFAULT 0,
  used_days     DECIMAL(5,1) NOT NULL DEFAULT 0,
  pending_days  DECIMAL(5,1) NOT NULL DEFAULT 0,             -- reserved by pending applications
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lb (employee_id, leave_type_id, year),
  CONSTRAINT fk_lb_emp  FOREIGN KEY (employee_id)   REFERENCES employees (id),
  CONSTRAINT fk_lb_type FOREIGN KEY (leave_type_id) REFERENCES leave_types (id),
  CONSTRAINT chk_lb_used CHECK (used_days >= 0 AND pending_days >= 0)
) ENGINE=InnoDB;

CREATE TABLE leave_applications (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_no   VARCHAR(30) NOT NULL,
  employee_id      BIGINT UNSIGNED NOT NULL,
  leave_type_id    BIGINT UNSIGNED NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  days             DECIMAL(4,1) NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  attachment_id    BIGINT UNSIGNED NULL,
  status           ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  submitted_by     BIGINT UNSIGNED NOT NULL,
  submitted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by       BIGINT UNSIGNED NULL,
  decided_at       DATETIME NULL,
  decision_remarks VARCHAR(500) NULL,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_la_no (application_no),
  KEY ix_la_emp (employee_id, status),
  KEY ix_la_status (status, submitted_at),
  KEY ix_la_dates (start_date, end_date),
  CONSTRAINT fk_la_emp  FOREIGN KEY (employee_id)   REFERENCES employees (id),
  CONSTRAINT fk_la_type FOREIGN KEY (leave_type_id) REFERENCES leave_types (id),
  CONSTRAINT fk_la_doc  FOREIGN KEY (attachment_id) REFERENCES document_attachments (id) ON DELETE SET NULL,
  CONSTRAINT fk_la_sub  FOREIGN KEY (submitted_by)  REFERENCES users (id),
  CONSTRAINT fk_la_dec  FOREIGN KEY (decided_by)    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_la_dates CHECK (end_date >= start_date AND days > 0)
) ENGINE=InnoDB;

CREATE TABLE leave_approvals (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  action         ENUM('approved','rejected') NOT NULL,
  actor_id       BIGINT UNSIGNED NOT NULL,
  actor_role     VARCHAR(40) NOT NULL,
  remarks        VARCHAR(500) NULL,
  decided_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_lap_app (application_id),
  CONSTRAINT fk_lap_app   FOREIGN KEY (application_id) REFERENCES leave_applications (id),
  CONSTRAINT fk_lap_actor FOREIGN KEY (actor_id)       REFERENCES users (id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- BANK ENROLLMENT
-- Account numbers are stored AES-256-GCM encrypted; only the last 4 digits are kept in clear for masking.
-- Enrolment does NOT move money. Real transfers need a separately authorised banking integration.
CREATE TABLE bank_accounts (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id         BIGINT UNSIGNED NOT NULL,
  bank_name           VARCHAR(120) NOT NULL,
  account_holder_name VARCHAR(160) NOT NULL,
  account_number_enc  VARCHAR(512) NOT NULL,
  account_last4       CHAR(4) NOT NULL,
  account_type        ENUM('savings','checking','payroll_card','e_wallet') NOT NULL,
  status              ENUM('active','superseded') NOT NULL DEFAULT 'active',
  active_flag         TINYINT(1) NULL,                        -- 1 for the single active payroll account, NULL otherwise
  approved_by         BIGINT UNSIGNED NOT NULL,
  approved_at         DATETIME NOT NULL,
  superseded_at       DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ba_one_active (employee_id, active_flag),
  CONSTRAINT fk_ba_emp  FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_ba_appr FOREIGN KEY (approved_by) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE bank_enrollment_requests (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_no          VARCHAR(30) NOT NULL,
  employee_id         BIGINT UNSIGNED NOT NULL,
  request_type        ENUM('new','update') NOT NULL DEFAULT 'new',
  bank_name           VARCHAR(120) NOT NULL,
  account_holder_name VARCHAR(160) NOT NULL,
  account_number_enc  VARCHAR(512) NOT NULL,
  account_last4       CHAR(4) NOT NULL,
  account_type        ENUM('savings','checking','payroll_card','e_wallet') NOT NULL,
  attachment_id       BIGINT UNSIGNED NULL,
  status              ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  submitted_by        BIGINT UNSIGNED NOT NULL,
  submitted_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by          BIGINT UNSIGNED NULL,
  decided_at          DATETIME NULL,
  decision_remarks    VARCHAR(500) NULL,
  resulting_account_id BIGINT UNSIGNED NULL,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ber_no (request_no),
  KEY ix_ber_emp (employee_id, status),
  KEY ix_ber_status (status, submitted_at),
  CONSTRAINT fk_ber_emp  FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_ber_doc  FOREIGN KEY (attachment_id) REFERENCES document_attachments (id) ON DELETE SET NULL,
  CONSTRAINT fk_ber_sub  FOREIGN KEY (submitted_by) REFERENCES users (id),
  CONSTRAINT fk_ber_dec  FOREIGN KEY (decided_by)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ber_acct FOREIGN KEY (resulting_account_id) REFERENCES bank_accounts (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE bank_enrollment_approvals (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id  BIGINT UNSIGNED NOT NULL,
  action      ENUM('approved','rejected') NOT NULL,
  actor_id    BIGINT UNSIGNED NOT NULL,
  actor_role  VARCHAR(40) NOT NULL,
  remarks     VARCHAR(500) NULL,
  decided_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_bea_req (request_id),
  CONSTRAINT fk_bea_req   FOREIGN KEY (request_id) REFERENCES bank_enrollment_requests (id),
  CONSTRAINT fk_bea_actor FOREIGN KEY (actor_id)   REFERENCES users (id)
) ENGINE=InnoDB;
