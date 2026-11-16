-- 025: HR compensation must stay within the active position salary band.
UPDATE position_compensation_bands
SET enforcement = 'block'
WHERE is_active = 1
  AND effective_to IS NULL;
