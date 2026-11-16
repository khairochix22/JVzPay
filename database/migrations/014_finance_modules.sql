-- Finance modules (master prompt §IX–§XI): accounts payable (supplier invoices and payments), accounts receivable
-- (customer receivables and collections), the company's bank accounts and bank reconciliation, budgets, and the
-- references JVzPay keeps of CRM sales and Inventory purchasing. Every money movement posts a balanced journal entry;
-- nothing posted is deleted — voids post reversals.

-- postings that come from CRM or Inventory events have no signed-in user; their source is source_type + the audit trail
ALTER TABLE journal_entries MODIFY created_by BIGINT UNSIGNED NULL;

INSERT IGNORE INTO chart_of_accounts (code, name, account_type, normal_balance, is_cash, is_system) VALUES
  ('1200', 'Merchandise Inventory', 'asset', 'debit', 0, 1),
  ('2300', 'Output VAT Payable', 'liability', 'credit', 0, 1),
  ('4030', 'Sales Returns and Discounts', 'revenue', 'debit', 0, 1),
  ('5050', 'Inventory Adjustments', 'expense', 'debit', 0, 1);

CREATE TABLE suppliers (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                VARCHAR(160) NOT NULL,
  contact_person      VARCHAR(120) NULL,
  phone               VARCHAR(40)  NULL,
  email               VARCHAR(190) NULL,
  address             VARCHAR(255) NULL,
  payment_terms_days  SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  inventory_ref       VARCHAR(80)  NULL,                    -- Inventory's supplier id, when the supplier came from Inventory
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sup_name (name),
  UNIQUE KEY uq_sup_inv (inventory_ref)
) ENGINE=InnoDB;

CREATE TABLE customers (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(160) NOT NULL,
  phone       VARCHAR(40)  NULL,
  email       VARCHAR(190) NULL,
  address     VARCHAR(255) NULL,
  crm_ref     VARCHAR(80)  NULL,                            -- CRM's customer id
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cust_crm (crm_ref),
  KEY ix_cust_name (name)
) ENGINE=InnoDB;

-- the company's own bank accounts (employee payroll accounts are in bank_accounts)
CREATE TABLE company_bank_accounts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bank_name       VARCHAR(120) NOT NULL,
  account_name    VARCHAR(160) NOT NULL,
  account_no_enc  VARCHAR(512) NOT NULL,
  account_last4   CHAR(4) NOT NULL,
  gl_account_id   BIGINT UNSIGNED NOT NULL,                 -- the cash account it is booked in (e.g. 1020 Cash in Bank)
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cba_gl (gl_account_id),
  CONSTRAINT fk_cba_gl FOREIGN KEY (gl_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT fk_cba_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE supplier_invoices (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  internal_no          VARCHAR(30)  NOT NULL,
  supplier_id          BIGINT UNSIGNED NOT NULL,
  invoice_no           VARCHAR(60)  NOT NULL,                -- the supplier's own invoice number
  invoice_date         DATE NOT NULL,
  due_date             DATE NOT NULL,
  amount               DECIMAL(14,2) NOT NULL,
  amount_paid          DECIMAL(14,2) NOT NULL DEFAULT 0,
  debit_account_id     BIGINT UNSIGNED NOT NULL,             -- what was bought: inventory, supplies, utilities …
  description          VARCHAR(255) NOT NULL,
  purchase_order_ref   VARCHAR(80)  NULL,
  goods_receipt_ref    VARCHAR(80)  NULL,
  match_status         ENUM('not_applicable','matched','unmatched') NOT NULL DEFAULT 'not_applicable',
  match_note           VARCHAR(255) NULL,
  source               ENUM('manual','inventory') NOT NULL DEFAULT 'manual',
  status               ENUM('pending_approval','unpaid','partially_paid','paid','rejected','voided') NOT NULL DEFAULT 'pending_approval',
  attachment_id        BIGINT UNSIGNED NULL,
  journal_entry_id     BIGINT UNSIGNED NULL,
  created_by           BIGINT UNSIGNED NULL,
  decided_by           BIGINT UNSIGNED NULL,
  decided_at           DATETIME NULL,
  decision_remarks     VARCHAR(500) NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_si_internal (internal_no),
  UNIQUE KEY uq_si_supplier_invoice (supplier_id, invoice_no),
  KEY ix_si_status (status, due_date),
  CONSTRAINT fk_si_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
  CONSTRAINT fk_si_account  FOREIGN KEY (debit_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT fk_si_doc      FOREIGN KEY (attachment_id) REFERENCES document_attachments (id) ON DELETE SET NULL,
  CONSTRAINT fk_si_je       FOREIGN KEY (journal_entry_id) REFERENCES journal_entries (id),
  CONSTRAINT fk_si_creator  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_si_decider  FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_si_amount  CHECK (amount > 0 AND amount_paid >= 0 AND amount_paid <= amount),
  CONSTRAINT chk_si_dates   CHECK (due_date >= invoice_date),
  CONSTRAINT chk_si_reject  CHECK (status <> 'rejected' OR (decision_remarks IS NOT NULL AND decision_remarks <> ''))
) ENGINE=InnoDB;

CREATE TABLE supplier_payments (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_no           VARCHAR(30) NOT NULL,
  supplier_invoice_id  BIGINT UNSIGNED NOT NULL,
  payment_date         DATE NOT NULL,
  amount               DECIMAL(14,2) NOT NULL,
  cash_account_id      BIGINT UNSIGNED NOT NULL,             -- 1010 Cash on Hand or a bank's cash account
  method               ENUM('cash','bank_transfer','check','e_wallet') NOT NULL,
  reference_no         VARCHAR(80) NULL,
  status               ENUM('posted','voided') NOT NULL DEFAULT 'posted',
  journal_entry_id     BIGINT UNSIGNED NOT NULL,
  created_by           BIGINT UNSIGNED NOT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sp_no (payment_no),
  KEY ix_sp_invoice (supplier_invoice_id),
  CONSTRAINT fk_sp_invoice FOREIGN KEY (supplier_invoice_id) REFERENCES supplier_invoices (id),
  CONSTRAINT fk_sp_cash    FOREIGN KEY (cash_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT fk_sp_je      FOREIGN KEY (journal_entry_id) REFERENCES journal_entries (id),
  CONSTRAINT fk_sp_user    FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT chk_sp_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE accounts_receivable (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  receivable_no        VARCHAR(30) NOT NULL,
  customer_id          BIGINT UNSIGNED NOT NULL,
  invoice_date         DATE NOT NULL,
  due_date             DATE NOT NULL,
  amount               DECIMAL(14,2) NOT NULL,
  amount_collected     DECIMAL(14,2) NOT NULL DEFAULT 0,
  description          VARCHAR(255) NOT NULL,
  revenue_account_id   BIGINT UNSIGNED NOT NULL,
  source               ENUM('manual','crm') NOT NULL DEFAULT 'manual',
  crm_transaction_id   VARCHAR(80) NULL,
  status               ENUM('unpaid','partially_paid','paid','voided') NOT NULL DEFAULT 'unpaid',
  journal_entry_id     BIGINT UNSIGNED NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ar_no (receivable_no),
  UNIQUE KEY uq_ar_crm (crm_transaction_id),
  KEY ix_ar_status (status, due_date),
  CONSTRAINT fk_ar_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_ar_revenue  FOREIGN KEY (revenue_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT fk_ar_je       FOREIGN KEY (journal_entry_id) REFERENCES journal_entries (id),
  CONSTRAINT fk_ar_creator  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_ar_amount  CHECK (amount > 0 AND amount_collected >= 0 AND amount_collected <= amount),
  CONSTRAINT chk_ar_dates   CHECK (due_date >= invoice_date)
) ENGINE=InnoDB;

CREATE TABLE customer_collections (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  collection_no     VARCHAR(30) NOT NULL,
  receivable_id     BIGINT UNSIGNED NOT NULL,
  collection_date   DATE NOT NULL,
  amount            DECIMAL(14,2) NOT NULL,
  cash_account_id   BIGINT UNSIGNED NOT NULL,
  method            ENUM('cash','bank_transfer','check','e_wallet') NOT NULL,
  reference_no      VARCHAR(80) NULL,
  journal_entry_id  BIGINT UNSIGNED NOT NULL,
  created_by        BIGINT UNSIGNED NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cc_no (collection_no),
  KEY ix_cc_ar (receivable_id),
  CONSTRAINT fk_cc_ar   FOREIGN KEY (receivable_id) REFERENCES accounts_receivable (id),
  CONSTRAINT fk_cc_cash FOREIGN KEY (cash_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT fk_cc_je   FOREIGN KEY (journal_entry_id) REFERENCES journal_entries (id),
  CONSTRAINT fk_cc_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT chk_cc_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE bank_reconciliations (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bank_account_id     BIGINT UNSIGNED NOT NULL,
  statement_date      DATE NOT NULL,
  statement_balance   DECIMAL(14,2) NOT NULL,
  status              ENUM('open','reconciled') NOT NULL DEFAULT 'open',
  cleared_balance     DECIMAL(14,2) NULL,                    -- set when reconciled
  notes               VARCHAR(255) NULL,
  created_by          BIGINT UNSIGNED NOT NULL,
  reconciled_by       BIGINT UNSIGNED NULL,
  reconciled_at       DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_br_statement (bank_account_id, statement_date),
  CONSTRAINT fk_br_bank FOREIGN KEY (bank_account_id) REFERENCES company_bank_accounts (id),
  CONSTRAINT fk_br_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_br_rec  FOREIGN KEY (reconciled_by) REFERENCES users (id)
) ENGINE=InnoDB;

-- a journal line is cleared against a bank statement once, ever
CREATE TABLE bank_reconciliation_items (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reconciliation_id      BIGINT UNSIGNED NOT NULL,
  journal_entry_line_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bri_line (journal_entry_line_id),
  KEY ix_bri_rec (reconciliation_id),
  CONSTRAINT fk_bri_rec  FOREIGN KEY (reconciliation_id) REFERENCES bank_reconciliations (id) ON DELETE CASCADE,
  CONSTRAINT fk_bri_line FOREIGN KEY (journal_entry_line_id) REFERENCES journal_entry_lines (id)
) ENGINE=InnoDB;

CREATE TABLE budgets (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fiscal_year  SMALLINT UNSIGNED NOT NULL,
  account_id   BIGINT UNSIGNED NOT NULL,
  month        TINYINT UNSIGNED NOT NULL,                    -- 1–12
  amount       DECIMAL(14,2) NOT NULL,
  updated_by   BIGINT UNSIGNED NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_budget (fiscal_year, account_id, month),
  CONSTRAINT fk_budget_account FOREIGN KEY (account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT fk_budget_user    FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_budget_month  CHECK (month BETWEEN 1 AND 12),
  CONSTRAINT chk_budget_amount CHECK (amount >= 0)
) ENGINE=InnoDB;

-- CRM completed sales as JVzPay recorded them (one row per CRM transaction; refunds and cancellations reverse it)
CREATE TABLE sales_imports (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transaction_id      VARCHAR(80) NOT NULL,
  order_id            VARCHAR(80) NULL,
  customer_ref        VARCHAR(80) NULL,
  transaction_date    DATE NOT NULL,
  payment_status      ENUM('paid','on_account') NOT NULL,
  gross_amount        DECIMAL(14,2) NOT NULL,
  discount_amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_amount        DECIMAL(14,2) NOT NULL,
  refunded_amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  line_items          JSON NOT NULL,
  status              ENUM('posted','cancelled','partially_refunded','refunded') NOT NULL DEFAULT 'posted',
  journal_entry_id    BIGINT UNSIGNED NOT NULL,
  receivable_id       BIGINT UNSIGNED NULL,
  inbox_id            BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_txn (transaction_id),
  KEY ix_sales_date (transaction_date),
  CONSTRAINT fk_sales_je FOREIGN KEY (journal_entry_id) REFERENCES journal_entries (id),
  CONSTRAINT fk_sales_ar FOREIGN KEY (receivable_id) REFERENCES accounts_receivable (id)
) ENGINE=InnoDB;

-- Inventory purchasing as JVzPay knows it, for three-way matching of supplier invoices
CREATE TABLE purchase_order_references (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_order_id  VARCHAR(80) NOT NULL,
  supplier_id        BIGINT UNSIGNED NOT NULL,
  order_date         DATE NOT NULL,
  total_amount       DECIMAL(14,2) NOT NULL,
  line_items         JSON NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_po (purchase_order_id),
  CONSTRAINT fk_po_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
) ENGINE=InnoDB;

CREATE TABLE goods_receipt_references (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  goods_receipt_id   VARCHAR(80) NOT NULL,
  purchase_order_id  VARCHAR(80) NOT NULL,
  received_date      DATE NOT NULL,
  total_amount       DECIMAL(14,2) NOT NULL,
  line_items         JSON NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gr (goods_receipt_id),
  KEY ix_gr_po (purchase_order_id)
) ENGINE=InnoDB;

INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('payables.prepare', 'accounting', 'Record supplier invoices and payments'),
  ('payables.approve', 'accounting', 'Approve or reject supplier invoices'),
  ('receivables.manage', 'accounting', 'Record customer receivables and collections'),
  ('bank.reconcile', 'accounting', 'Manage company bank accounts and reconcile them'),
  ('budgets.manage', 'accounting', 'Set budgets');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('payables.prepare', 'receivables.manage', 'bank.reconcile') WHERE r.code IN ('accounting_staff', 'accounting_supervisor');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('payables.approve', 'budgets.manage') WHERE r.code = 'accounting_supervisor';
