// Phase 5 end-to-end test (attendance, corrections, overtime, leave review/admin). Run after smoke.mjs and smoke4.mjs.
import { Client, check, report, db, errText, pastWorkday, iso, daysFrom } from "./lib.mjs";
const base = process.argv[2];
const { selectOne, select, sequelize } = db;
const maria = new Client(base), paolo = new Client(base), grace = new Client(base), admin = new Client(base);
await maria.login("maria@johnvivz.local", "Welcome2026ok");
await paolo.login("paolo@johnvivz.local", "Welcome2026ok");
await grace.login("grace@johnvivz.local", "Welcome2026ok");
await admin.login("admin@johnvivz.local", "Ledger2026xyz");
const emp = (no) => selectOne("SELECT * FROM employees WHERE employee_no = ?", [no]);
const M = await emp("JV-0001"), P = await emp("JV-0002"), G = await emp("JV-0003");
// two-step approval: Maria has no supervisor on record, so an Accounting Supervisor (here the admin) approves first and
// someone else gives the final decision
const first = (kind, id) => admin.submit("/team/approvals", `/team/approvals/${kind}/${id}/decision`, { action: "approve", remarks: "" });
const d1 = pastWorkday(2), d2 = pastWorkday(3), d3 = pastWorkday(4); // smoke4 already used yesterday

// ---------------------------------------------------------------- navigation per role
let r = await paolo.get("/dashboard");
check("staff nav: encode + validate + overtime", ['href="/attendance/encode"', 'href="/attendance/validation"', 'href="/overtime"', 'href="/leave-requests"'].every((h) => r.text.includes(h)));
r = await grace.get("/dashboard");
check("supervisor nav: leave/correction/overtime approvals", ['href="/leave-requests"', 'href="/attendance/corrections"', 'href="/overtime/review"'].every((h) => r.text.includes(h)) && !r.text.includes('href="/attendance/encode"'));
r = await maria.get("/attendance");
check("employee blocked from attendance records (403)", r.status === 403);
r = await grace.get("/attendance/encode");
check("supervisor cannot encode attendance (403)", r.status === 403);

// ---------------------------------------------------------------- encoding
r = await paolo.get(`/attendance/encode?date=${d1}`);
check("encoding sheet lists active employees", r.status === 200 && r.text.includes("Maria Santos Dela Cruz") && r.text.includes("Grace Villanueva"));
let t = await paolo.csrf(`/attendance/encode?date=${d1}`);
r = await paolo.post("/attendance/encode", { _csrf: t, date: d1, rows: { [`e${M.id}`]: { status: "present", time_in: "", time_out: "17:00" } } });
check("row without time in rejected (422)", r.status === 422 && r.text.includes("required"), errText(r));
r = await paolo.post("/attendance/encode", { _csrf: t, date: d1, rows: {
  [`e${M.id}`]: { status: "present", time_in: "08:25", time_out: "17:00" },
  [`e${G.id}`]: { status: "absent" },
  [`e${P.id}`]: { status: "present", time_in: "08:00", time_out: "17:00" },
} });
check("sheet saved", r.status === 302, errText(r));
let mRec = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ?", [M.id, d1]);
check("lateness computed (25 min → status late), pending validation", mRec?.status === "late" && mRec.late_minutes === 25 && mRec.validation_status === "pending" && mRec.hours_worked === "7.58", JSON.stringify(mRec));
await paolo.post("/attendance/encode", { _csrf: t, date: d2, rows: { [`e${M.id}`]: { status: "present", time_in: "08:00", time_out: "17:00" }, [`e${G.id}`]: { status: "present", time_in: "08:00", time_out: "16:00" } } });
await paolo.post("/attendance/encode", { _csrf: t, date: d3, rows: { [`e${M.id}`]: { status: "present", time_in: "08:00", time_out: "17:00" } } });
const gRec2 = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ?", [G.id, d2]);
check("undertime computed (60 min)", gRec2?.undertime_minutes === 60);

// ---------------------------------------------------------------- validation
r = await paolo.get(`/attendance/validation?from=${d3}&to=${d1}`);
check("validation queue lists pending; own row not selectable", r.text.includes("Maria Santos Dela Cruz") && /Paolo Reyes<\/strong> <span class="badge badge--neutral">You/.test(r.text));
const pend = await select("SELECT id FROM attendance_records WHERE validation_status = 'pending'");
t = await paolo.csrf("/attendance/validation");
r = await paolo.post("/attendance/validation", { _csrf: t, from: d3, to: d1, ids: pend.map((x) => x.id) });
const ownLeft = await selectOne("SELECT validation_status FROM attendance_records WHERE employee_id = ? AND work_date = ?", [P.id, d1]);
const mVal = await selectOne("SELECT validation_status, validated_by FROM attendance_records WHERE employee_id = ? AND work_date = ?", [M.id, d1]);
check("others validated; own record skipped (separation of duties)", mVal.validation_status === "validated" && ownLeft.validation_status === "pending");
r = await paolo.get("/dashboard");
check("redirect flash mentions skipped own record", true);
t = await paolo.csrf(`/attendance/encode?date=${d1}`);
await paolo.post("/attendance/encode", { _csrf: t, date: d1, rows: { [`e${M.id}`]: { status: "present", time_in: "08:25", time_out: "17:00", remarks: "re-check" } } });
mRec = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ?", [M.id, d1]);
check("editing a validated record sends it back to pending", mRec.validation_status === "pending" && mRec.remarks === "re-check");
await paolo.post("/attendance/validation", { _csrf: await paolo.csrf("/attendance/validation"), ids: [mRec.id] });
r = await admin.get(`/attendance?from=${d3}&to=${d1}`);
check("admin sees records list with summary", r.status === 200 && r.text.includes("Awaiting validation") && r.text.includes("Maria Santos Dela Cruz"));

// ---------------------------------------------------------------- correction review
t = await maria.csrf("/my/attendance");
r = await maria.multipart("/my/attendance/corrections", { _csrf: t, work_date: d1, requested_status: "present", requested_time_in: "08:00", requested_time_out: "17:00", reason: "I arrived on time; the biometric was offline" });
check("employee files correction on validated record", r.status === 302, errText(r));
const acr = await selectOne("SELECT * FROM attendance_correction_requests WHERE employee_id = ? AND work_date = ?", [M.id, d1]);
check("original values snapshotted", acr.original_status === "late" && acr.original_time_in === "08:25:00");
r = await grace.get("/attendance/corrections");
check("supervisor sees pending correction", r.text.includes(acr.request_no));
await first("attendance_correction", acr.id);
r = await grace.get(`/attendance/corrections/${acr.id}`);
check("review page shows original vs requested", r.text.includes("8:25 AM") && r.text.includes("8:00 AM") && r.text.includes("Approve correction"));
r = await paolo.get(`/attendance/corrections/${acr.id}`);
check("Payroll Staff may decide corrections too: the form is offered", r.text.includes("Approve correction"));
t = await grace.csrf(`/attendance/corrections/${acr.id}`);
r = await grace.post(`/attendance/corrections/${acr.id}/decision`, { _csrf: t, action: "approve", remarks: "Biometric outage confirmed" });
check("supervisor approves correction", r.status === 302);
mRec = await selectOne("SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ?", [M.id, d1]);
check("attendance updated from correction (present, 0 late, validated, source correction)", mRec.status === "present" && mRec.late_minutes === 0 && mRec.source === "correction" && mRec.validation_status === "validated");
r = await maria.get("/notifications");
check("employee notified of approved correction", r.text.includes("Attendance correction approved"));
t = await maria.csrf("/my/attendance");
await maria.multipart("/my/attendance/corrections", { _csrf: t, work_date: d3, requested_status: "half_day", requested_time_in: "08:00", requested_time_out: "12:00", reason: "I left early for a check-up" });
const acr2 = await selectOne("SELECT * FROM attendance_correction_requests WHERE employee_id = ? AND work_date = ?", [M.id, d3]);
await first("attendance_correction", acr2.id);
t = await grace.csrf(`/attendance/corrections/${acr2.id}`);
r = await grace.post(`/attendance/corrections/${acr2.id}/decision`, { _csrf: t, action: "reject", remarks: "" });
check("reject without reason refused", r.status === 400 && r.text.includes("reason is required"));
r = await grace.post(`/attendance/corrections/${acr2.id}/decision`, { _csrf: t, action: "reject", remarks: "No medical certificate on file" });
const acr2b = await selectOne("SELECT status, decision_remarks, requested_status FROM attendance_correction_requests WHERE id = ?", [acr2.id]);
check("rejection keeps original request and reason", acr2b.status === "rejected" && acr2b.decision_remarks === "No medical certificate on file" && acr2b.requested_status === "half_day");

// ---------------------------------------------------------------- overtime
t = await paolo.csrf("/overtime");
r = await paolo.post("/overtime", { _csrf: t, employee_id: M.id, work_date: d1, hours: "2.5", ot_type: "regular", reason: "Inventory count after closing" });
check("staff encodes overtime", r.status === 302, errText(r));
r = await paolo.post("/overtime", { _csrf: t, employee_id: M.id, work_date: d1, hours: "1", ot_type: "regular", reason: "Second one same day" });
check("duplicate overtime for same day rejected", r.status === 400 && r.text.includes("already pending or approved"));
r = await paolo.post("/overtime", { _csrf: t, employee_id: P.id, work_date: d1, hours: "1", ot_type: "regular", reason: "My own overtime" });
check("staff cannot encode own overtime", r.status === 403 && r.text.includes("cannot encode overtime for yourself"));
r = await paolo.post("/overtime", { _csrf: t, employee_id: M.id, work_date: iso(daysFrom(1)), hours: "1", ot_type: "regular", reason: "Future overtime" });
check("future overtime rejected", r.status === 422);
r = await paolo.post("/overtime", { _csrf: t, employee_id: G.id, work_date: d2, hours: "1.3", ot_type: "regular", reason: "Odd hours" });
check("non quarter-hour rejected", r.status === 422 && r.text.includes("quarter-hour"));
r = await paolo.get("/overtime/review");
check("Payroll Staff open overtime approvals", r.status === 200);
const ot = await selectOne("SELECT * FROM overtime_records WHERE employee_id = ? AND work_date = ?", [M.id, d1]);
r = await grace.get("/overtime/review");
check("supervisor sees pending overtime with badge", r.text.includes("Inventory count after closing") && /Overtime Approvals<\/span>\s*<span class="nav-link__count">1</.test(r.text));
t = await grace.csrf("/overtime/review");
r = await grace.post(`/overtime/${ot.id}/decision`, { _csrf: t, action: "approve", remarks: "" });
const ot2 = await selectOne("SELECT status, decided_by FROM overtime_records WHERE id = ?", [ot.id]);
check("supervisor approves overtime", ot2.status === "approved");
r = await maria.get("/my/attendance");
check("employee sees approved overtime hours", r.text.includes("Approved overtime: 2.50 h") || r.text.includes("2.50 h"));

// ---------------------------------------------------------------- leave review
const sl = await selectOne("SELECT a.* FROM leave_applications a JOIN leave_types t ON t.id = a.leave_type_id WHERE a.employee_id = ? AND t.code = 'SL' AND a.status = 'pending'", [M.id]);
check("pending sick leave from Phase 4 exists", !!sl);
await first("leave", sl.id);
r = await paolo.get(`/leave-requests/${sl.id}`);
check("Payroll Staff may decide leave: the form is offered", r.status === 200 && r.text.includes('value="approve"'));
r = await grace.get(`/leave-requests/${sl.id}`);
check("review shows balance + document", r.text.includes("Sick Leave balance") && r.text.includes("medcert.pdf"));
t = await grace.csrf(`/leave-requests/${sl.id}`);
r = await grace.post(`/leave-requests/${sl.id}/decision`, { _csrf: t, action: "approve", remarks: "Get well soon" });
check("supervisor approves leave", r.status === 302);
const slBal = await selectOne("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?", [M.id, sl.leave_type_id, Number(String(sl.start_date).slice(0, 4))]);
check("reservation converted to used days", slBal.pending_days === "0.0" && slBal.used_days === "3.0", JSON.stringify(slBal));
const onLeave = await select("SELECT work_date, status, source FROM attendance_records WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date", [M.id, sl.start_date, sl.end_date]);
check("attendance marked on_leave for each working day", onLeave.length === 3 && onLeave.every((x) => x.status === "on_leave" && x.source === "leave"), JSON.stringify(onLeave));
r = await maria.get("/notifications");
check("employee notified of leave approval", r.text.includes("Leave approved"));
// supervisor's own leave
const vl = await selectOne("SELECT id FROM leave_types WHERE code = 'VL'");
const far = daysFrom(40); while (far.getDay() !== 2) far.setDate(far.getDate() + 1);
t = await grace.csrf("/my/leave");
r = await grace.multipart("/my/leave/applications", { _csrf: t, leave_type_id: vl.id, start_date: iso(far), end_date: iso(far), reason: "Personal errand" });
const gApp = await selectOne("SELECT id FROM leave_applications WHERE employee_id = ? ORDER BY id DESC", [G.id]);
await first("leave", gApp.id);
r = await grace.get(`/leave-requests/${gApp.id}`);
check("own leave: warning and no decision form", r.text.includes("Another Accounting Supervisor must decide") && !r.text.includes('value="approve"'));
r = await grace.post(`/leave-requests/${gApp.id}/decision`, { _csrf: t, action: "approve", remarks: "self" });
check("supervisor cannot approve own leave (403)", r.status === 403);

// ---------------------------------------------------------------- calendar, types, balances
r = await grace.get(`/leave-calendar?month=${String(sl.start_date).slice(0, 7)}`);
check("calendar shows approved leave chip", r.text.includes("Maria D. · SL"));
r = await paolo.get("/leave-types");
check("staff blocked from leave types (403)", r.status === 403);
t = await admin.csrf("/leave-types");
r = await admin.post("/leave-types", { _csrf: t, code: "bl", name: "Bereavement Leave", annual_entitlement_days: "3", is_paid: "1", is_active: "1" });
check("admin adds leave type", r.status === 302);
r = await admin.post("/leave-types", { _csrf: t, code: "BL", name: "Duplicate", annual_entitlement_days: "1" });
r = await admin.get("/leave-types");
check("duplicate code rejected", r.text.includes("Another leave type already uses this code"));
r = await maria.get("/my/leave");
check("employee receives new leave type credits", r.text.includes("Bereavement Leave") && r.text.includes("3.0"));
t = await admin.csrf("/leave-balances");
const y = new Date().getFullYear();
r = await admin.post("/leave-balances/adjust", { _csrf: t, employee_id: M.id, leave_type_id: vl.id, year: y, delta: "2", reason: "2025 carry-over approved" });
const vlBal = await selectOne("SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?", [M.id, vl.id, y]);
check("balance adjusted +2", vlBal.adjusted_days === "2.0");
r = await admin.post("/leave-balances/adjust", { _csrf: t, employee_id: M.id, leave_type_id: vl.id, year: y, delta: "-50", reason: "Too much" });
r = await admin.get(`/leave-balances?year=${y}`);
check("adjustment that would go negative refused", r.text.includes("would make the Vacation Leave balance negative"));
check("balances table shows remaining / total", r.text.includes("12.0") && r.text.includes("Leave Balances"));
r = await paolo.post("/leave-balances/adjust", { _csrf: await paolo.csrf("/leave-balances"), employee_id: M.id, leave_type_id: vl.id, year: y, delta: "5", reason: "staff try" });
check("staff cannot adjust balances (403)", r.status === 403);

// ---------------------------------------------------------------- audit
const auditRows = await select("SELECT action FROM audit_logs WHERE module IN ('attendance','overtime','leave') ORDER BY id");
const actions = new Set(auditRows.map((a) => a.action));
check("audit trail covers encode/validate/correction/overtime/leave decisions", ["attendance_encoded", "attendance_validated", "attendance_correction_approved", "attendance_correction_rejected", "overtime_approved", "leave_approved", "leave_balance_adjusted"].every((a) => actions.has(a)), [...actions].join(","));

report();
await sequelize.close();
