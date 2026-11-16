-- Security hardening: expiring password-reset links, a sealed (tamper-evident) audit trail, privacy-notice acknowledgement,
-- and settings for automatic daily backups.

-- One-time password reset links. Only a SHA-256 of the token is stored; the link itself is shown once.
CREATE TABLE password_resets (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_by  BIGINT UNSIGNED NULL,
  ip_address  VARCHAR(45) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reset_token (token_hash),
  KEY ix_reset_user (user_id, used_at),
  CONSTRAINT fk_reset_user    FOREIGN KEY (user_id)    REFERENCES users (id),
  CONSTRAINT fk_reset_creator FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB;

-- Sealed audit trail: each record gets a sequence number and an HMAC chained to the previous record, so any later
-- change or removal is detected by "Verify audit trail". Sealing is the only update ever allowed on a record, once.
ALTER TABLE audit_logs
  ADD COLUMN seal_seq  BIGINT UNSIGNED NULL AFTER user_agent,
  ADD COLUMN seal_hash CHAR(64) NULL AFTER seal_seq,
  ADD UNIQUE KEY uq_audit_seal_seq (seal_seq);

DROP TRIGGER IF EXISTS trg_audit_logs_bu;
DELIMITER $$
CREATE TRIGGER trg_audit_logs_bu BEFORE UPDATE ON audit_logs FOR EACH ROW
BEGIN
  IF NOT (OLD.seal_seq IS NULL AND NEW.seal_seq IS NOT NULL AND NEW.seal_hash IS NOT NULL
          AND NEW.id <=> OLD.id AND NEW.user_id <=> OLD.user_id AND NEW.user_name <=> OLD.user_name AND NEW.user_role <=> OLD.user_role
          AND NEW.action <=> OLD.action AND NEW.module <=> OLD.module AND NEW.record_type <=> OLD.record_type AND NEW.record_id <=> OLD.record_id
          AND NEW.previous_value <=> OLD.previous_value AND NEW.new_value <=> OLD.new_value AND NEW.decision <=> OLD.decision
          AND NEW.remarks <=> OLD.remarks AND NEW.ip_address <=> OLD.ip_address AND NEW.user_agent <=> OLD.user_agent
          AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only: a record can only be sealed, once';
  END IF;
END$$
DELIMITER ;

-- Privacy notice acknowledgement (who read which version, and when)
ALTER TABLE users
  ADD COLUMN privacy_ack_version VARCHAR(20) NULL AFTER must_change_password,
  ADD COLUMN privacy_ack_at DATETIME NULL AFTER privacy_ack_version;
ALTER TABLE account_requests
  ADD COLUMN privacy_ack_version VARCHAR(20) NULL AFTER ip_address;

INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES
  ('privacy.notice_version', '2026-11-10', 'string', 'privacy', 'Privacy Notice version (change it to ask everyone to read the notice again)'),
  ('backup.auto_enabled', '1', 'boolean', 'backup', 'Back up the database automatically every day'),
  ('backup.time', '02:00', 'time', 'backup', 'Time of the automatic daily backup (or the first time the app runs after it)'),
  ('backup.keep_days', '14', 'number', 'backup', 'Days to keep automatic backups (the newest 3 are always kept)');
