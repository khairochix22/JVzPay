-- 026: HR is pull-only, approvals are done in ESS (team decision 2026-11-16).
--
-- 1. employees.hr_employee_code: HR's Employee Unique Code, kept because the agreed department-login answer
--    (POST /api/integration/v1/auth/login) returns it to CRM and Inventory. It cannot be used to register twice:
--    an employee registers once. The registration check itself still compares against hr_verification_hash.
-- 2. Requests that were waiting for HR's RequestDecided (routed_to = 'department') move to ESS: the immediate supervisor
--    in the same department approves first when they have an active ESS account; otherwise the first approval is not
--    required and the request goes straight to Accounting/Payroll's final approval.

ALTER TABLE employees
  ADD COLUMN hr_employee_code VARCHAR(64) NULL AFTER hr_verification_hash;

UPDATE leave_applications x
  JOIN employees e ON e.id = x.employee_id
  LEFT JOIN employees s ON s.hr_employee_id = e.supervisor_hr_id AND s.department_id = e.department_id AND s.id <> e.id AND s.deleted_at IS NULL
  LEFT JOIN users u ON u.employee_id = s.id AND u.status = 'active' AND u.deleted_at IS NULL
SET x.routed_to = 'accounting',
    x.supervisor_user_id = u.id,
    x.supervisor_status = IF(u.id IS NULL, 'not_required', 'pending'),
    x.supervisor_remarks = IF(u.id IS NULL, 'First approval not required: no supervisor with an ESS account in the department (moved from HR routing).', x.supervisor_remarks)
WHERE x.routed_to = 'department' AND x.status = 'pending' AND x.supervisor_status = 'pending';

UPDATE overtime_records x
  JOIN employees e ON e.id = x.employee_id
  LEFT JOIN employees s ON s.hr_employee_id = e.supervisor_hr_id AND s.department_id = e.department_id AND s.id <> e.id AND s.deleted_at IS NULL
  LEFT JOIN users u ON u.employee_id = s.id AND u.status = 'active' AND u.deleted_at IS NULL
SET x.routed_to = 'accounting',
    x.supervisor_user_id = u.id,
    x.supervisor_status = IF(u.id IS NULL, 'not_required', 'pending'),
    x.supervisor_remarks = IF(u.id IS NULL, 'First approval not required: no supervisor with an ESS account in the department (moved from HR routing).', x.supervisor_remarks)
WHERE x.routed_to = 'department' AND x.status = 'pending' AND x.supervisor_status = 'pending';

UPDATE attendance_correction_requests x
  JOIN employees e ON e.id = x.employee_id
  LEFT JOIN employees s ON s.hr_employee_id = e.supervisor_hr_id AND s.department_id = e.department_id AND s.id <> e.id AND s.deleted_at IS NULL
  LEFT JOIN users u ON u.employee_id = s.id AND u.status = 'active' AND u.deleted_at IS NULL
SET x.routed_to = 'accounting',
    x.supervisor_user_id = u.id,
    x.supervisor_status = IF(u.id IS NULL, 'not_required', 'pending'),
    x.supervisor_remarks = IF(u.id IS NULL, 'First approval not required: no supervisor with an ESS account in the department (moved from HR routing).', x.supervisor_remarks)
WHERE x.routed_to = 'department' AND x.status = 'pending' AND x.supervisor_status = 'pending';

UPDATE leave_conversions x
  JOIN employees e ON e.id = x.employee_id
  LEFT JOIN employees s ON s.hr_employee_id = e.supervisor_hr_id AND s.department_id = e.department_id AND s.id <> e.id AND s.deleted_at IS NULL
  LEFT JOIN users u ON u.employee_id = s.id AND u.status = 'active' AND u.deleted_at IS NULL
SET x.routed_to = 'accounting',
    x.supervisor_user_id = u.id,
    x.supervisor_status = IF(u.id IS NULL, 'not_required', 'pending'),
    x.supervisor_remarks = IF(u.id IS NULL, 'First approval not required: no supervisor with an ESS account in the department (moved from HR routing).', x.supervisor_remarks)
WHERE x.routed_to = 'department' AND x.status = 'pending' AND x.supervisor_status = 'pending';
