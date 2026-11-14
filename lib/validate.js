// Tiny declarative validator. Returns { values, errors } — `values` are trimmed/normalised, `errors` keyed by field.
//   const { values, errors } = validate(req.body, {
//     first_name: { label: "First name", required: true, max: 80 },
//     email: { type: "email" },
//     basic_salary: { type: "money", required: true, min: 0 },
//     employment_type: { type: "enum", values: ["regular", "probationary"] },
//   });
import { isMoney, toCents } from "./money.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[0-9+()\-\s]{7,20}$/;

export function validate(body = {}, schema) {
  const values = {};
  const errors = {};
  for (const [field, rule] of Object.entries(schema)) {
    const label = rule.label || field.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    let v = body[field];
    v = v === undefined || v === null ? "" : String(v).trim();

    if (v === "") {
      // an unchecked checkbox is simply absent from the form: that means false, never "missing"
      if (rule.type === "bool") { values[field] = rule.default ?? 0; continue; }
      if (rule.required) errors[field] = `${label} is required.`;
      values[field] = rule.default ?? null;
      continue;
    }
    switch (rule.type || "string") {
      case "email":
        if (!EMAIL.test(v)) errors[field] = `${label} must be a valid email address.`;
        v = v.toLowerCase();
        break;
      case "phone":
        if (!PHONE.test(v)) errors[field] = `${label} must be a valid phone number.`;
        break;
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) errors[field] = `${label} must be a valid date.`;
        break;
      case "money":
        if (!isMoney(v)) errors[field] = `${label} must be a valid amount (up to 2 decimals).`;
        else {
          v = v.replace(/,/g, "");
          const c = toCents(v);
          if (rule.min !== undefined && c < rule.min * 100) errors[field] = `${label} must be at least ${rule.min}.`;
          if (rule.max !== undefined && c > rule.max * 100) errors[field] = `${label} must not exceed ${rule.max}.`;
        }
        break;
      case "int": {
        if (!/^-?\d+$/.test(v)) errors[field] = `${label} must be a whole number.`;
        else {
          const n = Number(v);
          if (rule.min !== undefined && n < rule.min) errors[field] = `${label} must be at least ${rule.min}.`;
          if (rule.max !== undefined && n > rule.max) errors[field] = `${label} must not exceed ${rule.max}.`;
          v = n;
        }
        break;
      }
      case "enum":
        if (!rule.values.includes(v)) errors[field] = `${label} has an invalid value.`;
        break;
      case "id":
        if (!/^\d+$/.test(v)) errors[field] = `${label} is invalid.`;
        else v = Number(v);
        break;
      case "bool":
        v = ["1", "true", "on", "yes"].includes(v.toLowerCase()) ? 1 : 0;
        break;
      default:
        break;
    }
    if (typeof v === "string") {
      if (rule.min !== undefined && !rule.type && v.length < rule.min) errors[field] = `${label} must be at least ${rule.min} characters.`;
      if (rule.max !== undefined && (!rule.type || rule.type === "string") && v.length > rule.max) errors[field] = `${label} must not exceed ${rule.max} characters.`;
      if (rule.pattern && !rule.pattern.test(v)) errors[field] = rule.patternMessage || `${label} has an invalid format.`;
    }
    values[field] = v;
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

// Password policy: >= 10 chars, with letters and digits, not equal to the email.
export function checkPassword(pw, email = "") {
  if (!pw || pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 72) return "Password must not exceed 72 characters.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Password must contain both letters and numbers.";
  if (email && pw.toLowerCase().includes(String(email).split("@")[0].toLowerCase()) && String(email).split("@")[0].length > 3)
    return "Password must not contain your email name.";
  return null;
}
