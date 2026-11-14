/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// My Profile page (GET/POST /my/profile): own employment details (read-only) and permitted contact updates.
import { selectOne, exec } from "../../lib/db.js";
import { validate } from "../../lib/validate.js";
import { audit } from "../../lib/audit.js";
import { wrap } from "../../lib/errors.js";
import { getSetting } from "../../lib/settings.js";
import { getEmployee, govIds } from "../../services/employeeService.js";

const contactSchema = {
  email: { label: "Personal email", type: "email", max: 190 },
  phone: { label: "Mobile / phone", type: "phone" },
  address_line: { label: "Street / address", max: 255 },
  barangay: { label: "Barangay", max: 100 },
  municipality: { label: "Municipality", required: true, max: 100 },
  province: { label: "Province", required: true, max: 100 },
};


async function profilePage(req, res, extra = {}, status = 200) {
  const e = await getEmployee(req.user.employee_id);
  const showSalary = await getSetting("self.show_salary", true);
  res.status(status).render("my-profile", { title: "My Profile", e, gov: govIds(e, false), showSalary, form: e, errors: {}, ...extra });
}

export const showProfile = wrap((req, res) => profilePage(req, res));

export const updateContact = wrap(async (req, res) => {
  const { values, errors, ok } = validate(req.body, contactSchema);
  if (!ok) return profilePage(req, res, { form: values, errors, editing: true }, 422);
  const cur = await selectOne("SELECT email, phone, address_line, barangay, municipality, province FROM employees WHERE id = ?", [req.user.employee_id]);
  await exec(
    "UPDATE employees SET email = ?, phone = ?, address_line = ?, barangay = ?, municipality = ?, province = ?, updated_by = ? WHERE id = ?",
    [values.email, values.phone, values.address_line, values.barangay, values.municipality, values.province, req.user.id, req.user.employee_id]);
  await audit(req, { action: "own_contact_updated", module: "employees", recordType: "employee", recordId: req.user.employee_id, previous: cur, next: values });
  req.flash("success_msg", "Your contact information was updated.");
  res.redirect("/my/profile");
});
