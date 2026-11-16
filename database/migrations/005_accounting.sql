-- 005: accounting — chart of accounts, categories, transactions, journals (double-entry, posted entries immutable)

CREATE TABLE financial_periods (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  label      VARCHAR(60) NOT NULL,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  status     ENUM('open','closed') NOT NULL DEFAULT 'open',
  closed_by  BIGINT UNSIGNED NULL,
  closed_at  DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fp_range (start_date, end_date),
  CONSTRAINT fk_fp_user FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_fp_dates CHECK (end_date >= start_date)
) ENGINE=InnoDB;

CREATE TABLE chart_of_accounts (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(20)  NOT NULL,
  name           VARCHAR(120) NOT NULL,
  account_type   ENUM('asset','liability','equity','revenue','expense') NOT NULL,
  normal_balance ENUM('debit','credit') NOT NULL,
  parent_id      BIGINT UNSIGNED NULL,
  is_cash        TINYINT(1) NOT NULL DEFAULT 0,            -- cash / bank accounts (cash-flow statement)
  is_system      TINYINT(1) NOT NULL DEFAULT 0,            -- used by automated posting; cannot be deleted
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  description    VARCHAR(255) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_coa_code (code),
  KEY ix_coa_type (account_type),
  CONSTRAINT fk_coa_parent FOREIGN KEY (parent_id) REFERENCES chart_of_accounts (id)
) ENGINE=InnoDB;

CREATE TABLE transaction_categories (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_type      ENUM('income','expense') NOT NULL,
  name               VARCHAR(100) NOT NULL,
  default_account_id BIGINT UNSIGNED NOT NULL,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tc_name (category_type, name),
  CONSTRAINT fk_tc_acct FOREIGN KEY (default_account_id) REFERENCES chart_of_accounts (id)
) ENGINE=InnoDB;

CREATE TABLE journal_entries (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entry_no       VARCHAR(30) NOT NULL,
  entry_date     DATE NOT NULL,
  period_id      BIGINT UNSIGNED NULL,
  description    VARCHAR(255) NOT NULL,
  source_type    VARCHAR(40) NOT NULL DEFAULT 'manual',    -- payroll_batch | accounting_transaction | manual | reversal
  source_id      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  source_event   VARCHAR(30) NOT NULL DEFAULT 'posting',   -- accrual | disbursement | posting | reversal
  status         ENUM('draft','posted','reversed') NOT NULL DEFAULT 'draft',
  total_debit    DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_credit   DECIMAL(14,2) NOT NULL DEFAULT 0,
  reverses_entry_id BIGINT UNSIGNED NULL,
  created_by     BIGINT UNSIGNED NOT NULL,
  posted_by      BIGINT UNSIGNED NULL,
  posted_at      DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_je_no (entry_no),
  -- one posting per originating transaction/event: payroll can never be booked twice.
  -- Manual and reversal entries have no external origin, so the service sets source_id to the entry's own
  -- sequence number to keep this key unique for them.
  UNIQUE KEY uq_je_source (source_type, source_id, source_event),
  KEY ix_je_date (entry_date),
  KEY ix_je_status (status),
  CONSTRAINT fk_je_period  FOREIGN KEY (period_id)  REFERENCES financial_periods (id),
  CONSTRAINT fk_je_rev     FOREIGN KEY (reverses_entry_id) REFERENCES journal_entries (id),
  CONSTRAINT fk_je_creator FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_je_poster  FOREIGN KEY (posted_by)  REFERENCES users (id),
  CONSTRAINT chk_je_balance CHECK (status = 'draft' OR total_debit = total_credit)
) ENGINE=InnoDB;

CREATE TABLE journal_entry_lines (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entry_id    BIGINT UNSIGNED NOT NULL,
  line_no     SMALLINT UNSIGNED NOT NULL,
  account_id  BIGINT UNSIGNED NOT NULL,
  debit       DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit      DECIMAL(14,2) NOT NULL DEFAULT 0,
  description VARCHAR(255) NULL,
  employee_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jel_line (entry_id, line_no),
  KEY ix_jel_account (account_id),
  CONSTRAINT fk_jel_entry FOREIGN KEY (entry_id)    REFERENCES journal_entries (id),
  CONSTRAINT fk_jel_acct  FOREIGN KEY (account_id)  REFERENCES chart_of_accounts (id),
  CONSTRAINT fk_jel_emp   FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT chk_jel_amt  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND (debit + credit) > 0)
) ENGINE=InnoDB;

CREATE TABLE accounting_transactions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  txn_no           VARCHAR(30) NOT NULL,
  txn_type         ENUM('income','expense','adjustment') NOT NULL,
  category_id      BIGINT UNSIGNED NOT NULL,
  txn_date         DATE NOT NULL,
  amount           DECIMAL(14,2) NOT NULL,
  payment_method   ENUM('cash','bank_transfer','check','e_wallet','credit') NOT NULL DEFAULT 'cash',
  description      VARCHAR(255) NOT NULL,
  reference_no     VARCHAR(80) NULL,
  attachment_id    BIGINT UNSIGNED NULL,
  status           ENUM('pending_approval','posted','rejected','voided') NOT NULL DEFAULT 'posted',
  journal_entry_id BIGINT UNSIGNED NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  approved_by      BIGINT UNSIGNED NULL,
  approved_at      DATETIME NULL,
  decision_remarks VARCHAR(500) NULL,
  voided_by        BIGINT UNSIGNED NULL,
  voided_at        DATETIME NULL,
  void_reason      VARCHAR(500) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_at_no (txn_no),
  KEY ix_at_date (txn_date),
  KEY ix_at_type (txn_type, status),
  CONSTRAINT fk_at_cat   FOREIGN KEY (category_id)      REFERENCES transaction_categories (id),
  CONSTRAINT fk_at_doc   FOREIGN KEY (attachment_id)    REFERENCES document_attachments (id) ON DELETE SET NULL,
  CONSTRAINT fk_at_je    FOREIGN KEY (journal_entry_id) REFERENCES journal_entries (id),
  CONSTRAINT fk_at_cre   FOREIGN KEY (created_by)       REFERENCES users (id),
  CONSTRAINT fk_at_appr  FOREIGN KEY (approved_by)      REFERENCES users (id),
  CONSTRAINT fk_at_void  FOREIGN KEY (voided_by)        REFERENCES users (id),
  CONSTRAINT chk_at_amount CHECK (amount > 0),
  CONSTRAINT chk_at_sod CHECK (approved_by IS NULL OR approved_by <> created_by OR txn_type <> 'adjustment')
) ENGINE=InnoDB;

DELIMITER $$

-- Lines can only be written while the parent entry is still a draft
CREATE TRIGGER trg_jel_bi BEFORE INSERT ON journal_entry_lines FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(10);
  SELECT status INTO s FROM journal_entries WHERE id = NEW.entry_id;
  IF s <> 'draft' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted journal entries are immutable'; END IF;
END$$
CREATE TRIGGER trg_jel_bu BEFORE UPDATE ON journal_entry_lines FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(10);
  SELECT status INTO s FROM journal_entries WHERE id = OLD.entry_id;
  IF s <> 'draft' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted journal entries are immutable'; END IF;
END$$
CREATE TRIGGER trg_jel_bd BEFORE DELETE ON journal_entry_lines FOR EACH ROW
BEGIN
  DECLARE s VARCHAR(10);
  SELECT status INTO s FROM journal_entries WHERE id = OLD.entry_id;
  IF s <> 'draft' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted journal entries are immutable'; END IF;
END$$

-- Posting a draft: totals are derived from the lines and must balance (>= 2 lines).
-- After posting only posted -> reversed is allowed, and nothing financial may change.
CREATE TRIGGER trg_je_bu BEFORE UPDATE ON journal_entries FOR EACH ROW
BEGIN
  DECLARE d DECIMAL(14,2);
  DECLARE c DECIMAL(14,2);
  DECLARE n INT;
  IF OLD.status = 'reversed' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Reversed journal entries are immutable';
  END IF;
  IF OLD.status = 'posted' THEN
    IF NOT (NEW.status IN ('posted','reversed') AND NEW.entry_date <=> OLD.entry_date AND NEW.description <=> OLD.description
        AND NEW.total_debit <=> OLD.total_debit AND NEW.total_credit <=> OLD.total_credit
        AND NEW.source_type <=> OLD.source_type AND NEW.source_id <=> OLD.source_id AND NEW.source_event <=> OLD.source_event) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted journal entries are immutable; post a reversing entry instead';
    END IF;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*) INTO d, c, n FROM journal_entry_lines WHERE entry_id = OLD.id;
    IF n < 2 OR d <> c OR d = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Journal entry must have at least two lines and total debits must equal total credits';
    END IF;
    SET NEW.total_debit = d;
    SET NEW.total_credit = c;
  END IF;
END$$

CREATE TRIGGER trg_je_bd BEFORE DELETE ON journal_entries FOR EACH ROW
BEGIN
  IF OLD.status <> 'draft' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted journal entries cannot be deleted'; END IF;
END$$

-- Recorded income/expense: once posted, amount/date/type/category are frozen (void via reversal instead)
CREATE TRIGGER trg_at_bu BEFORE UPDATE ON accounting_transactions FOR EACH ROW
BEGIN
  IF OLD.status IN ('posted','voided') THEN
    IF NOT (NEW.amount <=> OLD.amount AND NEW.txn_date <=> OLD.txn_date AND NEW.txn_type <=> OLD.txn_type
        AND NEW.category_id <=> OLD.category_id AND NEW.payment_method <=> OLD.payment_method) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted transactions cannot be edited; void and re-enter with a documented reason';
    END IF;
  END IF;
END$$
CREATE TRIGGER trg_at_bd BEFORE DELETE ON accounting_transactions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Accounting transactions cannot be deleted; void them instead';
END$$

DELIMITER ;
