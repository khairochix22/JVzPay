-- Employees, departments and positions are maintained by the HR system from now on. Their pages are removed from JVzPay;
-- the three tables stay as the local copy that payroll, attendance and leave read, filled from HR once it is connected.

-- Accounting Staff sign up with their employee name, employee ID, position and the unique code HR gave them.
-- Until the HR database is connected nobody can confirm those details, so every request waits for a Super Admin.
CREATE TABLE account_requests (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name         VARCHAR(160) NOT NULL,
  employee_no       VARCHAR(40)  NOT NULL,
  position_title    VARCHAR(120) NOT NULL,
  hr_code_enc       VARCHAR(255) NOT NULL,            -- AES-256-GCM, so it can be re-checked against HR later
  email             VARCHAR(190) NOT NULL,
  password_hash     VARCHAR(100) NOT NULL,            -- bcrypt; becomes the account password on approval
  status            ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  hr_check          ENUM('not_connected','verified','not_found') NOT NULL DEFAULT 'not_connected',
  user_id           BIGINT UNSIGNED NULL,
  decided_by        BIGINT UNSIGNED NULL,
  decided_at        DATETIME NULL,
  decision_remarks  VARCHAR(500) NULL,
  ip_address        VARCHAR(45) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_ar_status (status),
  KEY ix_ar_email (email),
  KEY ix_ar_employee_no (employee_no),
  CONSTRAINT fk_ar_user    FOREIGN KEY (user_id)    REFERENCES users (id),
  CONSTRAINT fk_ar_decider FOREIGN KEY (decided_by) REFERENCES users (id),
  CONSTRAINT chk_ar_decided CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT chk_ar_reject_reason CHECK (status <> 'rejected' OR (decision_remarks IS NOT NULL AND decision_remarks <> ''))
) ENGINE=InnoDB;

INSERT INTO roles (code, name, description) VALUES
  ('accounting_staff', 'Accounting Staff', 'Records income and expenses for approval and views the books and financial reports.')
  ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('dashboard.view', 'accounting.view', 'accounting.prepare', 'reports.financial')
   WHERE r.code = 'accounting_staff';

-- permissions that only the removed Employees and Departments & Positions pages used
DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
 WHERE p.code IN ('employees.view', 'employees.manage', 'employees.salary.view', 'employees.salary.manage', 'employees.sensitive', 'org.manage');
DELETE FROM permissions
 WHERE code IN ('employees.view', 'employees.manage', 'employees.salary.view', 'employees.salary.manage', 'employees.sensitive', 'org.manage');
