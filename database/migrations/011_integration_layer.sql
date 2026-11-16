-- Integration layer (master prompt §III, §XII, §XIII; docs/API_INTEGRATION.md).
-- The four JOHNVIVZ applications keep separate databases and exchange signed events only.
--
-- * employees becomes the read-only HR reference (the master prompt's employee_references): every row carries the HR
--   employee id and when HR last synchronised it. JVzPay never creates a competing employee master.
-- * integration_clients: one service token per sending application (only a SHA-256 hash is stored).
-- * integration_inbox: every event received, idempotent by event_id and idempotency_key.
-- * integration_outbox: every event JVzPay sends, retried until the other application accepts it.
-- * integration_logs: one line per processing or delivery attempt, for the Integration page.

ALTER TABLE employees
  ADD COLUMN hr_employee_id       VARCHAR(40) NULL AFTER employee_no,
  ADD COLUMN hr_verification_hash CHAR(64)    NULL AFTER tin_enc,
  ADD COLUMN hr_synced_at         DATETIME    NULL AFTER hr_verification_hash,
  ADD COLUMN hr_event_id          VARCHAR(64) NULL AFTER hr_synced_at,
  ADD UNIQUE KEY uq_emp_hr (hr_employee_id);

CREATE TABLE integration_clients (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source        ENUM('johnvivz_hr','johnvivz_crm','johnvivz_inventory') NOT NULL,
  name          VARCHAR(120) NOT NULL,
  token_hash    CHAR(64) NOT NULL,
  token_hint    VARCHAR(8) NOT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_used_at  DATETIME NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at    DATETIME NULL,
  revoked_by    BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ic_token (token_hash),
  KEY ix_ic_source (source, is_active),
  CONSTRAINT fk_ic_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ic_revoker FOREIGN KEY (revoked_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE integration_inbox (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id         VARCHAR(64)  NOT NULL,
  idempotency_key  VARCHAR(190) NULL,
  client_id        BIGINT UNSIGNED NULL,
  source           ENUM('johnvivz_hr','johnvivz_crm','johnvivz_inventory') NOT NULL,
  event_type       VARCHAR(60)  NOT NULL,
  schema_version   SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  entity_id        VARCHAR(80)  NULL,
  correlation_id   VARCHAR(64)  NULL,
  occurred_at      DATETIME     NULL,
  payload          JSON         NOT NULL,
  status           ENUM('received','processed','failed') NOT NULL DEFAULT 'received',
  error            VARCHAR(500) NULL,
  attempts         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  result_ref       VARCHAR(80)  NULL,
  received_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at     DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inbox_event (event_id),
  UNIQUE KEY uq_inbox_idem (idempotency_key),
  KEY ix_inbox_status (status, received_at),
  KEY ix_inbox_type (source, event_type),
  KEY ix_inbox_entity (entity_id),
  CONSTRAINT fk_inbox_client FOREIGN KEY (client_id) REFERENCES integration_clients (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE integration_outbox (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id         CHAR(36)     NOT NULL,
  target           ENUM('hr','crm','inventory') NOT NULL,
  event_type       VARCHAR(60)  NOT NULL,
  entity_id        VARCHAR(80)  NULL,
  correlation_id   CHAR(36)     NULL,
  payload          JSON         NOT NULL,
  status           ENUM('pending','sent','failed','not_connected') NOT NULL DEFAULT 'pending',
  attempts         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_error       VARCHAR(500) NULL,
  next_attempt_at  DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at          DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbox_event (event_id),
  KEY ix_outbox_due (status, next_attempt_at),
  KEY ix_outbox_entity (entity_id)
) ENGINE=InnoDB;

CREATE TABLE integration_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  direction   ENUM('in','out') NOT NULL,
  inbox_id    BIGINT UNSIGNED NULL,
  outbox_id   BIGINT UNSIGNED NULL,
  outcome     ENUM('processed','duplicate','failed','sent','retry','not_connected','rejected') NOT NULL,
  message     VARCHAR(500) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_il_in (inbox_id),
  KEY ix_il_out (outbox_id),
  KEY ix_il_time (created_at),
  CONSTRAINT fk_il_inbox  FOREIGN KEY (inbox_id)  REFERENCES integration_inbox (id) ON DELETE CASCADE,
  CONSTRAINT fk_il_outbox FOREIGN KEY (outbox_id) REFERENCES integration_outbox (id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT IGNORE INTO permissions (code, module, description) VALUES
  ('integration.manage', 'integration', 'Manage integration tokens and retry failed events');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'integration.manage' WHERE r.code = 'accounting_supervisor';
