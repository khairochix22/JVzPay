import bcrypt from "bcrypt";
import crypto from "crypto";
import { select, selectOne } from "../lib/db.js";
import { decrypt, maskNumber } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";

export const RATE_BASES = ["monthly", "daily", "hourly"];
export const PAY_FREQUENCIES = ["weekly", "semi_monthly", "monthly"];

// Fields that define pay and employment terms. Changing them requires employees.salary.manage.
const GOV_ID_FIELDS = { sss_no: "sss_no_enc", philhealth_no: "philhealth_no_enc", pagibig_no: "pagibig_no_enc", tin: "tin_enc" };

export const fullName = (e) => [e.first_name, e.middle_name, e.last_name, e.suffix].filter(Boolean).join(" ");

export async function lookups() {
  const [departments, positions] = await Promise.all([
    select("SELECT id, code, name FROM departments WHERE deleted_at IS NULL AND is_active = 1 ORDER BY name"),
    select("SELECT id, department_id, title FROM positions WHERE deleted_at IS NULL AND is_active = 1 ORDER BY title"),
  ]);
  return { departments, positions };
}

// ---- list ----------------------------------------------------------------------------------------------------------

// ---- single record -----------------------------------------------------------------------------------------------
export async function getEmployee(id) {
  const e = await selectOne(
    `SELECT e.*, d.name AS department, p.title AS position, u.id AS user_id, u.email AS login_email, u.status AS login_status, u.last_login_at
       FROM employees e
       JOIN departments d ON d.id = e.department_id
       JOIN positions p ON p.id = e.position_id
       LEFT JOIN users u ON u.employee_id = e.id AND u.deleted_at IS NULL
      WHERE e.id = ? AND e.deleted_at IS NULL`,
    [id]
  );
  if (!e) throw notFound("Employee not found.");
  e.name = fullName(e);
  return e;
}

// Government IDs: decrypted ONLY here, and only unmasked for holders of employees.sensitive.
export function govIds(e, reveal) {
  const out = {};
  for (const [key, col] of Object.entries(GOV_ID_FIELDS)) {
    let plain = null;
    try { plain = e[col] ? decrypt(e[col]) : null; } catch { plain = null; }
    out[key] = { set: !!plain, display: plain ? (reveal ? plain : maskNumber(plain, 3)) : "Not provided" };
  }
  return out;
}


// ---- create -----------------------------------------------------------------------------------------------------------




// ---- login accounts --------------------------------------------------------------------------------------------------------
export const makeTempPassword = () => crypto.randomBytes(7).toString("base64url") + "9a#";
export const hashPassword = (p) => bcrypt.hash(p, 12);
