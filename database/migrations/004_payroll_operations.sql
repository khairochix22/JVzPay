-- 004: payroll batches, records, breakdown lines, payslips, approvals, adjustments
-- Integrity enforced IN THE DATABASE so no code path (including a super admin console) can silently alter approved/finalized money.

CREATE TABLE payroll_batches (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_no            VARCHAR(30) NOT NULL,
  period_id           BIGINT UNSIGNED NOT NULL,
  department_id       BIGINT UNSIGNED NULL,                    -- NULL = all departments
  status              ENUM('draft','for_review','approved','finalized','released','voided') NOT NULL DEFAULT 'draft',
  employee_count      INT UNSIGNED NOT NULL DEFAULT 0,
  total_gross         DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_deductions    DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_net           DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_employer_contributions DECIMAL(14,2) NOT NULL DEFAULT 0,
  prepared_by         BIGINT UNSIGNED NOT NULL,
  submitted_by        BIGINT UNSIGNED NULL,
  submitted_at        DATETIME NULL,
  approved_by         BIGINT UNSIGNED NULL,
  approved_at         DATETIME NULL,
  finalized_by        BIGINT UNSIGNED NULL,
  finalized_at        DATETIME NULL,
  released_by         BIGINT UNSIGNED NULL,
  released_at         DATETIME NULL,
  voided_by           BIGINT UNSIGNED NULL,
  voided_at           DATETIME NULL,
  void_reason         VARCHAR(500) NULL,
  last_rejection_reason VARCHAR(500) NULL,
  remarks             VARCHAR(500) NULL,
  rules_snapshot      JSON NULL,                               -- statutory rule ids / settings used (reproducibility)
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pb_no (batch_no),
  KEY ix_pb_period (period_id, status),
  KEY ix_pb_status (status),
  CONSTRAINT fk_pb_period FOREIGN KEY (period_id)     REFERENCES payroll_periods (id),
  CONSTRAINT fk_pb_dept   FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT fk_pb_prep   FOREIGN KEY (prepared_by)   REFERENCES users (id),
  CONSTRAINT fk_pb_sub    FOREIGN KEY (submitted_by)  REFERENCES users (id),
  CONSTRAINT fk_pb_appr   FOREIGN KEY (approved_by)   REFERENCES users (id),
  CONSTRAINT fk_pb_fin    FOREIGN KEY (finalized_by)  REFERENCES users (id),
  CONSTRAINT fk_pb_rel    FOREIGN KEY (released_by)   REFERENCES users (id),
  CONSTRAINT fk_pb_void   FOREIGN KEY (voided_by)     REFERENCES users (id),
  -- separation of duties at the data layer: the approver can never be the preparer or submitter
  CONSTRAINT chk_pb_sod CHECK (approved_by IS NULL OR (approved_by <> prepared_by AND (submitted_by IS NULL OR approved_by <> submitted_by)))
) ENGINE=InnoDB;

CREATE TABLE payroll_records (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id              BIGINT UNSIGNED NOT NULL,
  period_id             BIGINT UNSIGNED NOT NULL,
  employee_id           BIGINT UNSIGNED NOT NULL,
  status                ENUM('draft','for_review','approved','finalized','released','voided') NOT NULL DEFAULT 'draft',
  active_flag           TINYINT(1) NULL DEFAULT 1,              -- 1 while active, NULL when voided (frees the slot)
  -- snapshot of employee data at computation time (payslip must not change when the master record changes)
  employee_no           VARCHAR(20)  NOT NULL,
  employee_name         VARCHAR(200) NOT NULL,
  department_name       VARCHAR(120) NULL,
  position_title        VARCHAR(120) NULL,
  rate_basis            ENUM('monthly','daily','hourly') NOT NULL,
  rate_amount           DECIMAL(12,2) NOT NULL,
  -- quantities used
  days_worked           DECIMAL(6,2) NOT NULL DEFAULT 0,
  days_absent           DECIMAL(6,2) NOT NULL DEFAULT 0,
  late_minutes          INT UNSIGNED NOT NULL DEFAULT 0,
  undertime_minutes     INT UNSIGNED NOT NULL DEFAULT 0,
  overtime_hours        DECIMAL(7,2) NOT NULL DEFAULT 0,
  -- earnings
  basic_pay             DECIMAL(14,2) NOT NULL DEFAULT 0,
  overtime_pay          DECIMAL(14,2) NOT NULL DEFAULT 0,
  holiday_pay           DECIMAL(14,2) NOT NULL DEFAULT 0,
  night_diff_pay        DECIMAL(14,2) NOT NULL DEFAULT 0,
  allowances            DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_earnings        DECIMAL(14,2) NOT NULL DEFAULT 0,
  gross_pay             DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- deductions
  statutory_employee    DECIMAL(14,2) NOT NULL DEFAULT 0,       -- SSS + PhilHealth + Pag-IBIG employee share
  withholding_tax       DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_deductions      DECIMAL(14,2) NOT NULL DEFAULT 0,       -- absence/late, loans, authorised others
  total_deductions      DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_pay               DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- employer side (an expense, NOT deducted from the employee)
  employer_contributions DECIMAL(14,2) NOT NULL DEFAULT 0,
  computation_notes     JSON NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pr_one_active (employee_id, period_id, active_flag),   -- no duplicate payroll per employee/period
  KEY ix_pr_batch (batch_id),
  KEY ix_pr_period (period_id),
  KEY ix_pr_status (status),
  CONSTRAINT fk_pr_batch  FOREIGN KEY (batch_id)    REFERENCES payroll_batches (id),
  CONSTRAINT fk_pr_period FOREIGN KEY (period_id)   REFERENCES payroll_periods (id),
  CONSTRAINT fk_pr_emp    FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT chk_pr_gross CHECK (gross_pay = basic_pay + overtime_pay + holiday_pay + night_diff_pay + allowances + other_earnings),
  CONSTRAINT chk_pr_ded   CHECK (total_deductions = statutory_employee + withholding_tax + other_deductions),
  CONSTRAINT chk_pr_net   CHECK (net_pay = gross_pay - total_deductions),
  CONSTRAINT chk_pr_nonneg CHECK (net_pay >= 0 AND gross_pay >= 0 AND employer_contributions >= 0)
) ENGINE=InnoDB;

CREATE TABLE payroll_earnings (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_id    BIGINT UNSIGNED NOT NULL,
  component_id BIGINT UNSIGNED NOT NULL,
  description  VARCHAR(200) NOT NULL,
  quantity     DECIMAL(10,2) NOT NULL DEFAULT 1,
  rate         DECIMAL(12,4) NOT NULL DEFAULT 0,
  amount       DECIMAL(14,2) NOT NULL,
  source_type  VARCHAR(40) NULL,                               -- attendance | overtime | pay_item | adjustment
  source_id    BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_pe_record (record_id),
  CONSTRAINT fk_pe_rec  FOREIGN KEY (record_id)    REFERENCES payroll_records (id),
  CONSTRAINT fk_pe_comp FOREIGN KEY (component_id) REFERENCES salary_components (id)
) ENGINE=InnoDB;

CREATE TABLE payroll_deductions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_id    BIGINT UNSIGNED NOT NULL,
  component_id BIGINT UNSIGNED NOT NULL,
  description  VARCHAR(200) NOT NULL,
  amount       DECIMAL(14,2) NOT NULL,
  source_type  VARCHAR(40) NULL,
  source_id    BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_pd_record (record_id),
  CONSTRAINT fk_pd_rec  FOREIGN KEY (record_id)    REFERENCES payroll_records (id),
  CONSTRAINT fk_pd_comp FOREIGN KEY (component_id) REFERENCES salary_components (id)
) ENGINE=InnoDB;

CREATE TABLE payroll_contributions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_id      BIGINT UNSIGNED NOT NULL,
  agency         ENUM('SSS','PHILHEALTH','PAGIBIG') NOT NULL,
  rule_id        BIGINT UNSIGNED NULL,
  base_amount    DECIMAL(14,2) NOT NULL,
  employee_share DECIMAL(14,2) NOT NULL,
  employer_share DECIMAL(14,2) NOT NULL,
  ec_share       DECIMAL(14,2) NOT NULL DEFAULT 0,             -- employer-only EC (SSS)
  PRIMARY KEY (id),
  UNIQUE KEY uq_pc_rec_agency (record_id, agency),
  CONSTRAINT fk_pc_rec  FOREIGN KEY (record_id) REFERENCES payroll_records (id),
  CONSTRAINT fk_pc_rule FOREIGN KEY (rule_id)   REFERENCES statutory_contribution_rules (id)
) ENGINE=InnoDB;

CREATE TABLE payslips (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payslip_no    VARCHAR(30) NOT NULL,
  record_id     BIGINT UNSIGNED NOT NULL,
  employee_id   BIGINT UNSIGNED NOT NULL,
  status        ENUM('generated','released') NOT NULL DEFAULT 'generated',
  content_hash  CHAR(64) NULL,
  generated_by  BIGINT UNSIGNED NOT NULL,
  generated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at    DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ps_no (payslip_no),
  UNIQUE KEY uq_ps_record (record_id),
  KEY ix_ps_emp (employee_id, status),
  CONSTRAINT fk_ps_rec FOREIGN KEY (record_id)    REFERENCES payroll_records (id),
  CONSTRAINT fk_ps_emp FOREIGN KEY (employee_id)  REFERENCES employees (id),
  CONSTRAINT fk_ps_gen FOREIGN KEY (generated_by) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE payroll_approvals (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id    BIGINT UNSIGNED NOT NULL,
  action      ENUM('submitted','approved','rejected','finalized','released','voided') NOT NULL,
  actor_id    BIGINT UNSIGNED NOT NULL,
  actor_role  VARCHAR(40) NOT NULL,
  remarks     VARCHAR(500) NULL,
  decided_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_pa_batch (batch_id, decided_at),
  CONSTRAINT fk_pa_batch FOREIGN KEY (batch_id) REFERENCES payroll_batches (id),
  CONSTRAINT fk_pa_actor FOREIGN KEY (actor_id) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE payroll_adjustments (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  adjustment_no    VARCHAR(30) NOT NULL,
  employee_id      BIGINT UNSIGNED NOT NULL,
  period_id        BIGINT UNSIGNED NOT NULL,                  -- period in which the adjustment is applied
  source_record_id BIGINT UNSIGNED NULL,                      -- finalized record being corrected, if any
  adjustment_type  ENUM('earning','deduction') NOT NULL,
  component_id     BIGINT UNSIGNED NOT NULL,
  amount           DECIMAL(12,2) NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  status           ENUM('pending','approved','rejected','applied') NOT NULL DEFAULT 'pending',
  submitted_by     BIGINT UNSIGNED NOT NULL,
  submitted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by       BIGINT UNSIGNED NULL,
  decided_at       DATETIME NULL,
  decision_remarks VARCHAR(500) NULL,
  applied_record_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_padj_no (adjustment_no),
  KEY ix_padj_status (status),
  KEY ix_padj_emp (employee_id, period_id),
  CONSTRAINT fk_padj_emp    FOREIGN KEY (employee_id)       REFERENCES employees (id),
  CONSTRAINT fk_padj_period FOREIGN KEY (period_id)         REFERENCES payroll_periods (id),
  CONSTRAINT fk_padj_src    FOREIGN KEY (source_record_id)  REFERENCES payroll_records (id),
  CONSTRAINT fk_padj_comp   FOREIGN KEY (component_id)      REFERENCES salary_components (id),
  CONSTRAINT fk_padj_sub    FOREIGN KEY (submitted_by)      REFERENCES users (id),
  CONSTRAINT fk_padj_dec    FOREIGN KEY (decided_by)        REFERENCES users (id),
  CONSTRAINT fk_padj_applied FOREIGN KEY (applied_record_id) REFERENCES payroll_records (id),
  CONSTRAINT chk_padj_amount CHECK (amount > 0),
  CONSTRAINT chk_padj_sod CHECK (decided_by IS NULL OR decided_by <> submitted_by)
) ENGINE=InnoDB;

-- deferred foreign keys from 003
ALTER TABLE attendance_records
  ADD CONSTRAINT fk_att_batch FOREIGN KEY (locked_batch_id) REFERENCES payroll_batches (id) ON DELETE SET NULL;
ALTER TABLE overtime_records
  ADD CONSTRAINT fk_ot_record FOREIGN KEY (payroll_record_id) REFERENCES payroll_records (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- TRIGGERS
DELIMITER $$

-- Approved / finalized / released records: money and identity columns are frozen; status may only move forward.
CREATE TRIGGER trg_pr_bu BEFORE UPDATE ON payroll_records FOR EACH ROW
BEGIN
  IF OLD.status = 'voided' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Voided payroll records cannot be modified';
  END IF;
  IF OLD.status IN ('approved','finalized','released') THEN
    IF NOT (NEW.employee_id <=> OLD.employee_id AND NEW.period_id <=> OLD.period_id AND NEW.batch_id <=> OLD.batch_id
        AND NEW.rate_amount <=> OLD.rate_amount AND NEW.days_worked <=> OLD.days_worked AND NEW.overtime_hours <=> OLD.overtime_hours
        AND NEW.basic_pay <=> OLD.basic_pay AND NEW.overtime_pay <=> OLD.overtime_pay AND NEW.holiday_pay <=> OLD.holiday_pay
        AND NEW.night_diff_pay <=> OLD.night_diff_pay AND NEW.allowances <=> OLD.allowances AND NEW.other_earnings <=> OLD.other_earnings
        AND NEW.gross_pay <=> OLD.gross_pay AND NEW.statutory_employee <=> OLD.statutory_employee AND NEW.withholding_tax <=> OLD.withholding_tax
        AND NEW.other_deductions <=> OLD.other_deductions AND NEW.total_deductions <=> OLD.total_deductions AND NEW.net_pay <=> OLD.net_pay
        AND NEW.employer_contributions <=> OLD.employer_contributions) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approved/finalized payroll records cannot be edited. Use the authorised adjustment or void process.';
    END IF;
    IF NOT ((OLD.status = 'approved'  AND NEW.status IN ('approved','finalized','voided'))
         OR (OLD.status = 'finalized' AND NEW.status IN ('finalized','released','voided'))
         OR (OLD.status = 'released'  AND NEW.status IN ('released','voided'))) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid payroll status transition';
    END IF;
  END IF;
END$$

CREATE TRIGGER trg_pr_bd BEFORE DELETE ON payroll_records FOR EACH ROW
BEGIN
  IF OLD.status NOT IN ('draft','for_review') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approved/finalized payroll records cannot be deleted';
  END IF;
END$$

CREATE TRIGGER trg_pb_bu BEFORE UPDATE ON payroll_batches FOR EACH ROW
BEGIN
  IF OLD.status IN ('approved','finalized','released','voided') THEN
    IF NOT (NEW.period_id <=> OLD.period_id AND NEW.total_gross <=> OLD.total_gross AND NEW.total_deductions <=> OLD.total_deductions
        AND NEW.total_net <=> OLD.total_net AND NEW.total_employer_contributions <=> OLD.total_employer_contributions
        AND NEW.employee_count <=> OLD.employee_count AND NEW.prepared_by <=> OLD.prepared_by) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approved/finalized payroll batch totals cannot be modified';
    END IF;
    IF OLD.status = 'voided' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Voided payroll batches cannot be modified';
    END IF;
  END IF;
END$$

CREATE TRIGGER trg_pb_bd BEFORE DELETE ON payroll_batches FOR EACH ROW
BEGIN
  IF OLD.status NOT IN ('draft') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only draft payroll batches can be deleted';
  END IF;
END$$

-- Breakdown lines are frozen once their record leaves draft/for_review
CREATE TRIGGER trg_pe_bi BEFORE INSERT ON payroll_earnings FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = NEW.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$
CREATE TRIGGER trg_pe_bu BEFORE UPDATE ON payroll_earnings FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = OLD.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$
CREATE TRIGGER trg_pe_bd BEFORE DELETE ON payroll_earnings FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = OLD.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$

CREATE TRIGGER trg_pd_bi BEFORE INSERT ON payroll_deductions FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = NEW.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$
CREATE TRIGGER trg_pd_bu BEFORE UPDATE ON payroll_deductions FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = OLD.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$
CREATE TRIGGER trg_pd_bd BEFORE DELETE ON payroll_deductions FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = OLD.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$

CREATE TRIGGER trg_pc_bi BEFORE INSERT ON payroll_contributions FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = NEW.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$
CREATE TRIGGER trg_pc_bu BEFORE UPDATE ON payroll_contributions FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = OLD.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$
CREATE TRIGGER trg_pc_bd BEFORE DELETE ON payroll_contributions FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(20);
  SELECT status INTO s FROM payroll_records WHERE id = OLD.record_id;
  IF s NOT IN ('draft','for_review') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payroll record is locked'; END IF;
END$$

-- Decision logs are append-only
CREATE TRIGGER trg_pa_bu  BEFORE UPDATE ON payroll_approvals FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approval history is append-only'; END$$
CREATE TRIGGER trg_pa_bd  BEFORE DELETE ON payroll_approvals FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approval history is append-only'; END$$
CREATE TRIGGER trg_lap_bu BEFORE UPDATE ON leave_approvals FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approval history is append-only'; END$$
CREATE TRIGGER trg_lap_bd BEFORE DELETE ON leave_approvals FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approval history is append-only'; END$$
CREATE TRIGGER trg_aca_bu BEFORE UPDATE ON attendance_correction_approvals FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approval history is append-only'; END$$
CREATE TRIGGER trg_aca_bd BEFORE DELETE ON attendance_correction_approvals FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approval history is append-only'; END$$
CREATE TRIGGER trg_bea_bu BEFORE UPDATE ON bank_enrollment_approvals FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approval history is append-only'; END$$
CREATE TRIGGER trg_bea_bd BEFORE DELETE ON bank_enrollment_approvals FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Approval history is append-only'; END$$

DELIMITER ;
