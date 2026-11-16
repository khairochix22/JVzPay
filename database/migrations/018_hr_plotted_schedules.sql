-- Owner's clarification, 2026-11-13: schedules are plotted by HR day by day and can change at any time, days off
-- included — there is no fixed weekly pattern. HR sends each plotted day (ScheduleDaysPlotted); JVzPay keeps one row per
-- employee and date. A day with no plotted schedule follows the company default from System Settings.
-- Breaks are paid and lunch is not; every minute past the plotted break or lunch is lost time, deducted from pay and
-- shown on the payslip as lost hours (attendance_records.overbreak_minutes, payroll_records.overbreak_minutes).

-- the weekly pattern of 017 is replaced by plotted days (it was never filled in the real database)
DROP TABLE work_schedules;

CREATE TABLE schedule_days (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id     BIGINT UNSIGNED NOT NULL,
  work_date       DATE NOT NULL,
  is_day_off      TINYINT(1) NOT NULL DEFAULT 0,
  shift_start     TIME NULL,
  am_break_start  TIME NULL,
  lunch_start     TIME NULL,
  lunch_end       TIME NULL,
  pm_break_start  TIME NULL,
  shift_end       TIME NULL,
  remarks         VARCHAR(255) NULL,
  hr_event_id     VARCHAR(64) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sd_emp_date (employee_id, work_date),
  KEY ix_sd_date (work_date),
  CONSTRAINT fk_sd_emp FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT chk_sd_times CHECK (is_day_off = 1 OR (shift_start < am_break_start AND am_break_start < lunch_start AND lunch_start < lunch_end
                                                    AND lunch_end < pm_break_start AND pm_break_start < shift_end))
) ENGINE=InnoDB;

ALTER TABLE attendance_records ADD COLUMN overbreak_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER undertime_minutes;
ALTER TABLE payroll_records ADD COLUMN overbreak_minutes INT UNSIGNED NOT NULL DEFAULT 0 AFTER undertime_minutes;

INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES
  ('attendance.am_break_start', '10:00', 'time', 'attendance', 'Default morning break start (15 minutes, paid)'),
  ('attendance.pm_break_start', '15:00', 'time', 'attendance', 'Default afternoon break start (15 minutes, paid)');
-- pay rates as most Philippine companies apply them (DOLE): all on the basic salary only
INSERT IGNORE INTO system_settings (setting_key, setting_value, value_type, group_name, description) VALUES
  ('payroll.rest_day_multiplier', '1.3', 'number', 'payroll', 'Approved work on a day off, first 8 hours (130%)'),
  ('payroll.holiday_multiplier_regular_rest_day', '2.6', 'number', 'payroll', 'Work on a regular holiday that falls on a day off (260%)'),
  ('payroll.holiday_multiplier_special_rest_day', '1.5', 'number', 'payroll', 'Work on a special non-working day that falls on a day off (150%)');
UPDATE system_settings SET description = 'Overtime on a day off or special day, beyond 8 hours (169%)' WHERE setting_key = 'payroll.ot_multiplier_rest_day';
UPDATE system_settings SET description = 'Regular holiday worked: double pay (200% of the basic daily rate)' WHERE setting_key = 'payroll.holiday_multiplier_regular';
UPDATE system_settings SET description = 'Special non-working day worked: 30% extra (130% of the basic daily rate)' WHERE setting_key = 'payroll.holiday_multiplier_special';
UPDATE system_settings SET description = 'Default lunch start (one hour, unpaid)' WHERE setting_key = 'attendance.lunch_start';
UPDATE system_settings SET description = 'Default day off (0=Sunday … 6=Saturday) when HR has not plotted the day' WHERE setting_key = 'attendance.rest_day';
UPDATE system_settings SET description = 'Default second day off (0=Sunday … 6=Saturday, blank for none) when HR has not plotted the day' WHERE setting_key = 'attendance.rest_day_2';

UPDATE permissions SET description = 'View the schedules HR plotted for employees' WHERE code = 'schedules.manage';
