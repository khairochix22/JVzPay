-- 001: access control, organisation, employees, platform tables (audit, notifications, settings, documents)
-- Conventions: BIGINT UNSIGNED ids, DATETIME business timestamps (connection tz = +08:00), DECIMAL money, soft delete via deleted_at.

-- ---------------------------------------------------------------- ACCESS
CREATE TABLE roles (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(40)  NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  description VARCHAR(255) NULL,
  is_system   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_code (code)
) ENGINE=InnoDB;

CREATE TABLE permissions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(80)  NOT NULL,
  module      VARCHAR(40)  NOT NULL,
  description VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_code (code),
  KEY ix_permissions_module (module)
) ENGINE=InnoDB;

CREATE TABLE role_permissions (
  role_id       BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_perm FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE users (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id           BIGINT UNSIGNED NULL,
  role_id               BIGINT UNSIGNED NOT NULL,
  email                 VARCHAR(190) NOT NULL,
  full_name             VARCHAR(160) NOT NULL,
  password_hash         VARCHAR(100) NOT NULL,
  status                ENUM('active','inactive','locked') NOT NULL DEFAULT 'active',
  must_change_password  TINYINT(1)   NOT NULL DEFAULT 1,
  failed_login_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until          DATETIME NULL,
  last_login_at         DATETIME NULL,
  last_login_ip         VARCHAR(45) NULL,
  password_changed_at   DATETIME NULL,
  created_by            BIGINT UNSIGNED NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at            DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_employee (employee_id),
  KEY ix_users_role (role_id),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_users_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE user_sessions (
  sid        VARCHAR(128) NOT NULL,
  user_id    BIGINT UNSIGNED NULL,
  data       MEDIUMTEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (sid),
  KEY ix_sessions_expires (expires_at),
  KEY ix_sessions_user (user_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- PLATFORM
CREATE TABLE system_settings (
  setting_key   VARCHAR(100) NOT NULL,
  setting_value TEXT NULL,
  value_type    ENUM('string','number','boolean','json','time') NOT NULL DEFAULT 'string',
  group_name    VARCHAR(50)  NOT NULL DEFAULT 'general',
  description   VARCHAR(255) NULL,
  updated_by    BIGINT UNSIGNED NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  KEY ix_settings_group (group_name)
) ENGINE=InnoDB;

-- Atomic document numbering: INSERT ... ON DUPLICATE KEY UPDATE current_value = LAST_INSERT_ID(current_value + 1)
CREATE TABLE sequences (
  name          VARCHAR(80) NOT NULL,
  current_value BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB;

CREATE TABLE document_attachments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_type    VARCHAR(50)  NOT NULL,           -- e.g. leave_application, bank_enrollment_request, accounting_transaction
  owner_id      BIGINT UNSIGNED NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(255) NOT NULL,           -- random name on disk, never user supplied
  mime_type     VARCHAR(100) NOT NULL,
  size_bytes    INT UNSIGNED NOT NULL,
  sha256        CHAR(64) NOT NULL,
  uploaded_by   BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at    DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_docs_stored (stored_name),
  KEY ix_docs_owner (owner_type, owner_id),
  CONSTRAINT fk_docs_user FOREIGN KEY (uploaded_by) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE notifications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  type         VARCHAR(50)  NOT NULL,
  title        VARCHAR(160) NOT NULL,
  message      VARCHAR(500) NOT NULL,
  related_type VARCHAR(50)  NULL,
  related_id   BIGINT UNSIGNED NULL,
  link_url     VARCHAR(255) NULL,
  is_read      TINYINT(1) NOT NULL DEFAULT 0,
  read_at      DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_notif_user (user_id, is_read, created_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE announcements (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title        VARCHAR(160) NOT NULL,
  body         TEXT NOT NULL,
  audience     ENUM('all','staff','employees') NOT NULL DEFAULT 'all',
  published_by BIGINT UNSIGNED NOT NULL,
  published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_ann_active (is_active, published_at),
  CONSTRAINT fk_ann_user FOREIGN KEY (published_by) REFERENCES users (id)
) ENGINE=InnoDB;

-- Append-only audit trail. Deliberately no FKs so history survives any later change to users/records.
CREATE TABLE audit_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NULL,
  user_name      VARCHAR(160) NULL,
  user_role      VARCHAR(40)  NULL,
  action         VARCHAR(60)  NOT NULL,
  module         VARCHAR(40)  NOT NULL,
  record_type    VARCHAR(60)  NULL,
  record_id      VARCHAR(40)  NULL,
  previous_value JSON NULL,
  new_value      JSON NULL,
  decision       ENUM('approved','rejected') NULL,
  remarks        VARCHAR(500) NULL,
  ip_address     VARCHAR(45)  NULL,
  user_agent     VARCHAR(255) NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_user (user_id, created_at),
  KEY ix_audit_module (module, created_at),
  KEY ix_audit_record (record_type, record_id),
  KEY ix_audit_created (created_at)
) ENGINE=InnoDB;

DELIMITER $$
CREATE TRIGGER trg_audit_logs_bu BEFORE UPDATE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only: updates are not permitted';
END$$
CREATE TRIGGER trg_audit_logs_bd BEFORE DELETE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only: deletes are not permitted';
END$$
DELIMITER ;

-- ---------------------------------------------------------------- ORGANISATION
CREATE TABLE departments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(20)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dept_code (code),
  UNIQUE KEY uq_dept_name (name)
) ENGINE=InnoDB;

CREATE TABLE positions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  department_id BIGINT UNSIGNED NOT NULL,
  title         VARCHAR(120) NOT NULL,
  description   VARCHAR(255) NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pos_dept_title (department_id, title),
  CONSTRAINT fk_pos_dept FOREIGN KEY (department_id) REFERENCES departments (id)
) ENGINE=InnoDB;

CREATE TABLE employees (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_no       VARCHAR(20)  NOT NULL,
  first_name        VARCHAR(80)  NOT NULL,
  middle_name       VARCHAR(80)  NULL,
  last_name         VARCHAR(80)  NOT NULL,
  suffix            VARCHAR(10)  NULL,
  gender            ENUM('male','female','other') NULL,
  birth_date        DATE NULL,
  email             VARCHAR(190) NULL,
  phone             VARCHAR(30)  NULL,
  address_line      VARCHAR(255) NULL,
  barangay          VARCHAR(100) NULL,
  municipality      VARCHAR(100) NOT NULL DEFAULT 'Bongabong',
  province          VARCHAR(100) NOT NULL DEFAULT 'Oriental Mindoro',
  department_id     BIGINT UNSIGNED NOT NULL,
  position_id       BIGINT UNSIGNED NOT NULL,
  employment_type   ENUM('regular','probationary','contractual','part_time','seasonal') NOT NULL DEFAULT 'probationary',
  employment_status ENUM('active','on_leave','suspended','resigned','terminated') NOT NULL DEFAULT 'active',
  date_hired        DATE NOT NULL,
  date_separated    DATE NULL,
  rate_basis        ENUM('monthly','daily','hourly') NOT NULL DEFAULT 'monthly',
  basic_salary      DECIMAL(12,2) NOT NULL,
  pay_frequency     ENUM('weekly','semi_monthly','monthly') NOT NULL DEFAULT 'semi_monthly',
  is_mwe            TINYINT(1) NOT NULL DEFAULT 0,          -- minimum wage earner (exempt from withholding tax)
  sss_no_enc        VARCHAR(255) NULL,                      -- AES-256-GCM encrypted at app layer
  philhealth_no_enc VARCHAR(255) NULL,
  pagibig_no_enc    VARCHAR(255) NULL,
  tin_enc           VARCHAR(255) NULL,
  created_by        BIGINT UNSIGNED NULL,
  updated_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_emp_no (employee_no),
  KEY ix_emp_dept (department_id),
  KEY ix_emp_pos (position_id),
  KEY ix_emp_status (employment_status),
  KEY ix_emp_name (last_name, first_name),
  CONSTRAINT fk_emp_dept FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT fk_emp_pos  FOREIGN KEY (position_id)  REFERENCES positions (id),
  CONSTRAINT fk_emp_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_emp_updater FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_emp_salary CHECK (basic_salary >= 0),
  CONSTRAINT chk_emp_dates  CHECK (date_separated IS NULL OR date_separated >= date_hired)
) ENGINE=InnoDB;

ALTER TABLE users
  ADD CONSTRAINT fk_users_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL;

CREATE TABLE employment_history (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id   BIGINT UNSIGNED NOT NULL,
  change_type   ENUM('hired','promotion','transfer','status_change','type_change','separation','reinstatement') NOT NULL,
  from_department_id BIGINT UNSIGNED NULL,
  to_department_id   BIGINT UNSIGNED NULL,
  from_position_id   BIGINT UNSIGNED NULL,
  to_position_id     BIGINT UNSIGNED NULL,
  from_status   VARCHAR(30) NULL,
  to_status     VARCHAR(30) NULL,
  from_type     VARCHAR(30) NULL,
  to_type       VARCHAR(30) NULL,
  effective_date DATE NOT NULL,
  remarks       VARCHAR(255) NULL,
  recorded_by   BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_eh_emp (employee_id, effective_date),
  CONSTRAINT fk_eh_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_eh_user FOREIGN KEY (recorded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE salary_history (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id     BIGINT UNSIGNED NOT NULL,
  previous_amount DECIMAL(12,2) NULL,
  new_amount      DECIMAL(12,2) NOT NULL,
  rate_basis      ENUM('monthly','daily','hourly') NOT NULL,
  pay_frequency   ENUM('weekly','semi_monthly','monthly') NOT NULL,
  effective_date  DATE NOT NULL,
  reason          VARCHAR(255) NULL,
  recorded_by     BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_sh_emp (employee_id, effective_date),
  CONSTRAINT fk_sh_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT fk_sh_user FOREIGN KEY (recorded_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_sh_amount CHECK (new_amount >= 0)
) ENGINE=InnoDB;
