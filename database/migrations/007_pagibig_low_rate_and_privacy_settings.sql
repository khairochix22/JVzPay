-- Pag-IBIG (HDMF Circular 460): the employee share is 1% when the monthly fund salary is ₱1,500 or below, 2% above that.
-- A rule with low_income_ceiling = 0 has no lower band. The employer share is never affected.
ALTER TABLE statutory_contribution_rules
  ADD COLUMN low_income_ceiling DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER employer_rate,
  ADD COLUMN low_income_employee_rate DECIMAL(7,6) NOT NULL DEFAULT 0.000000 AFTER low_income_ceiling;

UPDATE statutory_contribution_rules
   SET low_income_ceiling = 1500.00, low_income_employee_rate = 0.010000,
       notes = '2% each on a monthly fund salary capped at ₱10,000; the employee share is 1% at ₱1,500 or below.'
 WHERE agency = 'PAGIBIG' AND effective_from = '2024-02-01';

-- Details shown in the Privacy Notice. The first three stay blank until the store designates someone.
INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES
  ('privacy.accountable_person', '', 'string', 'privacy', 'Person accountable for data privacy (Data Protection Officer)'),
  ('privacy.contact_email', '', 'string', 'privacy', 'Data privacy contact email'),
  ('privacy.contact_phone', '', 'string', 'privacy', 'Data privacy contact phone'),
  ('privacy.retention', 'Employment and payroll records are kept for at least 3 years after the last entry, and tax and accounting records for up to 10 years, or longer while a claim, audit or case is open.', 'string', 'privacy', 'How long records are kept (shown in the Privacy Notice)');
