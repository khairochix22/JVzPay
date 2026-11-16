-- 024: approved HR position catalog
-- Legacy positions are retained for historical employee records but removed from
-- the active hiring catalog. Existing employees are not reassigned or repriced.

UPDATE departments
SET name = CASE code
  WHEN 'HR' THEN 'Human Resource (HR) Management'
  WHEN 'PAYROLL_ACCOUNTING' THEN 'Accounting & Payroll Management'
  WHEN 'CRM' THEN 'Customer Relation Management'
  WHEN 'INVENTORY' THEN 'Inventory Management'
  ELSE name
END,
description = CASE code
  WHEN 'HR' THEN 'Human resources operations, employee records, hiring, and HR compliance'
  WHEN 'PAYROLL_ACCOUNTING' THEN 'Accounting, payroll processing, compensation, and financial controls'
  WHEN 'CRM' THEN 'Customer relations, customer support, and relationship management'
  WHEN 'INVENTORY' THEN 'Inventory control, stock accuracy, receiving, and release operations'
  ELSE description
END
WHERE code IN ('HR', 'PAYROLL_ACCOUNTING', 'CRM', 'INVENTORY');

UPDATE positions p
JOIN departments d ON d.id = p.department_id
SET p.is_active = 0, p.deleted_at = COALESCE(p.deleted_at, CURRENT_TIMESTAMP)
WHERE d.code IN ('ADMIN', 'HR', 'PAYROLL_ACCOUNTING', 'CRM', 'INVENTORY');

INSERT INTO positions (department_id, title, description, is_active)
SELECT d.id, v.title, v.description, 1
FROM departments d
JOIN (
  SELECT 'HR' department_code, 'HR Supervisor' title, 'Leads HR operations, employee lifecycle, policy administration, and HR approvals' description
  UNION ALL SELECT 'HR', 'HR Staff', 'Handles recruitment support, employee records, onboarding, and HR transactions'
  UNION ALL SELECT 'PAYROLL_ACCOUNTING', 'Manager/Supervisor', 'Leads accounting and payroll operations, controls, approvals, and reporting'
  UNION ALL SELECT 'PAYROLL_ACCOUNTING', 'Staff', 'Processes payroll, accounting entries, reconciliations, and records'
  UNION ALL SELECT 'CRM', 'Manager', 'Owns customer relationship strategy, service performance, and team results'
  UNION ALL SELECT 'CRM', 'Team Leader', 'Supervises customer relations agents and daily service delivery'
  UNION ALL SELECT 'CRM', 'Agent', 'Handles customer inquiries, requests, follow-up, and service records'
  UNION ALL SELECT 'INVENTORY', 'Manager', 'Owns inventory accuracy, stock planning, controls, and reporting'
  UNION ALL SELECT 'INVENTORY', 'Staff', 'Performs receiving, counting, picking, issuing, and inventory records'
) v ON v.department_code = d.code
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  is_active = 1,
  deleted_at = NULL;

-- Position-based national private-sector planning bands.
INSERT INTO position_compensation_bands
  (position_id, effective_from, minimum_monthly, midpoint_monthly, maximum_monthly,
   enforcement, benchmark_basis, review_notes)
SELECT p.id, '2026-11-13', v.minimum_monthly, v.midpoint_monthly, v.maximum_monthly,
       'flag',
       '2026 Philippine private-sector directional benchmark; HR validates scope, experience, location, and offer competitiveness',
       'Review annually and whenever responsibilities materially change'
FROM positions p
JOIN departments d ON d.id = p.department_id
JOIN (
  SELECT 'HR' department_code, 'HR Supervisor' title, 28000 minimum_monthly, 36000 midpoint_monthly, 45000 maximum_monthly
  UNION ALL SELECT 'HR', 'HR Staff', 18000, 24000, 32000
  UNION ALL SELECT 'PAYROLL_ACCOUNTING', 'Manager/Supervisor', 35000, 45000, 60000
  UNION ALL SELECT 'PAYROLL_ACCOUNTING', 'Staff', 20000, 26000, 34000
  UNION ALL SELECT 'CRM', 'Manager', 35000, 45000, 60000
  UNION ALL SELECT 'CRM', 'Team Leader', 25000, 32000, 40000
  UNION ALL SELECT 'CRM', 'Agent', 16000, 21000, 28000
  UNION ALL SELECT 'INVENTORY', 'Manager', 30000, 40000, 55000
  UNION ALL SELECT 'INVENTORY', 'Staff', 16000, 21000, 28000
) v ON v.department_code = d.code AND v.title = p.title
WHERE p.is_active = 1
  AND NOT EXISTS (
    SELECT 1 FROM position_compensation_bands b
    WHERE b.position_id = p.id AND b.effective_from = '2026-11-13'
  );

-- Standard HR offer package. Rice and clothing use the 2026 de minimis ceilings;
-- transport and communication are taxable unless documented as business reimbursement.
INSERT INTO position_allowance_packages
  (position_id, effective_from, allowance_code, allowance_name, amount, frequency,
   taxable, de_minimis_cap, eligibility_note)
SELECT p.id, '2026-11-13', a.allowance_code, a.allowance_name, a.amount, a.frequency,
       a.taxable, a.de_minimis_cap, a.eligibility_note
FROM positions p
JOIN departments d ON d.id = p.department_id
JOIN (
  SELECT 'RICE' allowance_code, 'Rice subsidy' allowance_name, 2500 amount, 'monthly' frequency, 0 taxable, 2500 de_minimis_cap, 'All active employees' AS eligibility_note
  UNION ALL SELECT 'CLOTHING', 'Clothing/uniform allowance', 8000, 'annual', 0, 8000, 'Annual issuance or reimbursement'
  UNION ALL SELECT 'TRANSPORT', 'Transportation allowance', 1500, 'monthly', 1, NULL, 'Role-related travel or commute support'
) a
WHERE p.is_active = 1
  AND d.code IN ('HR', 'PAYROLL_ACCOUNTING', 'CRM', 'INVENTORY')
  AND NOT EXISTS (
    SELECT 1 FROM position_allowance_packages x
    WHERE x.position_id = p.id AND x.effective_from = '2026-11-13'
      AND x.allowance_code = a.allowance_code
  );
