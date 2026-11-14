// What a payroll record actually costs the store, in SQL over `payroll_records r`. Pay for unworked days is listed in gross
// and then deducted as an absence, so it is never an expense. These match the accrual journal written at finalization.
export const ABSENCE_SQL = "(SELECT COALESCE(SUM(d.amount), 0) FROM payroll_deductions d JOIN salary_components c ON c.id = d.component_id WHERE d.record_id = r.id AND c.category = 'absence')";
export const EARNED_SALARY_SQL = `(r.gross_pay - r.overtime_pay - ${ABSENCE_SQL})`;
export const PAYROLL_EXPENSE_SQL = `(r.gross_pay + r.employer_contributions + r.retirement_company_share - ${ABSENCE_SQL})`;
