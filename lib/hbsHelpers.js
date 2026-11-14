import hbs from "hbs";
import { formatPHP } from "./money.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// DATE columns arrive as "YYYY-MM-DD" strings; DATETIME as Date. Both are formatted without timezone drift.
function parts(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return { y: v.getFullYear(), m: v.getMonth(), d: v.getDate(), hh: v.getHours(), mm: v.getMinutes() };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(v));
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3], hh: m[4] != null ? +m[4] : 0, mm: m[5] != null ? +m[5] : 0 } : null;
}

const humanize = (s) => String(s ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const BADGE = {
  // positive
  active: "success", approved: "success", released: "success", finalized: "info", posted: "success", validated: "success",
  open: "info", present: "success", paid: "success", verified: "success", applied: "success", generated: "info",
  // pending
  pending: "warning", for_review: "warning", draft: "neutral", pending_approval: "warning", on_leave: "info", late: "warning",
  half_day: "warning", locked: "danger", suspended: "warning",
  // negative
  rejected: "danger", voided: "danger", absent: "danger", terminated: "danger", inactive: "neutral", resigned: "neutral",
  cancelled: "neutral", closed: "neutral", superseded: "neutral", reversed: "neutral",
  changed: "neutral", withdrawn: "neutral", stopped: "neutral", rest_day: "neutral", holiday: "info",
  // integration and payables
  processed: "success", sent: "success", received: "info", not_connected: "warning", failed: "danger", unpaid: "warning", partially_paid: "info", matched: "success", unmatched: "warning", reconciled: "success", overdue: "danger",
};

export function registerHelpers() {
  const h = hbs.registerHelper.bind(hbs);

  h("eq", (a, b) => a === b || (a != null && b != null && String(a) === String(b)));
  h("ne", (a, b) => String(a) !== String(b));
  h("gt", (a, b) => Number(a) > Number(b));
  h("lt", (a, b) => Number(a) < Number(b));
  h("and", (...a) => a.slice(0, -1).every(Boolean));
  h("or", (...a) => a.slice(0, -1).some(Boolean));
  h("not", (a) => !a);
  h("add", (a, b) => Number(a) + Number(b));
  h("array", (...a) => a.slice(0, -1)); // {{#each (array "a" "b")}}
  h("concat", (...a) => a.slice(0, -1).join("")); // (concat "/x/" id "/y")
  h("default", (a, b) => (a === null || a === undefined || a === "" ? b : a));

  // {{#if (can "employees.manage")}} — reads the logged-in user's permission list from the render context
  h("can", (code, options) => !!options?.data?.root?.me?.permissions?.includes(code));

  h("humanize", humanize);
  h("upper", (s) => String(s ?? "").toUpperCase());
  h("initials", (name) => String(name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(""));
  h("money", (v) => formatPHP(v));
  h("pct", (v) => `${+(Number(v) * 100).toFixed(4)}%`); // 0.025 -> 2.5%
  h("number", (v) => (v === null || v === undefined || v === "" ? "0" : Number(v).toLocaleString("en-PH")));
  h("fixed", (v, n) => (Number(v) || 0).toFixed(typeof n === "number" ? n : 1));

  h("date", (v) => {
    const p = parts(v);
    return p ? `${MONTHS[p.m]} ${p.d}, ${p.y}` : "—";
  });
  h("datetime", (v) => {
    const p = parts(v);
    if (!p) return "—";
    const h12 = p.hh % 12 || 12;
    return `${MONTHS[p.m]} ${p.d}, ${p.y} ${h12}:${String(p.mm).padStart(2, "0")} ${p.hh < 12 ? "AM" : "PM"}`;
  });
  h("time", (v) => {
    if (!v) return "—";
    const m = /^(\d{2}):(\d{2})/.exec(String(v));
    if (!m) return "—";
    const hh = +m[1];
    return `${hh % 12 || 12}:${m[2]} ${hh < 12 ? "AM" : "PM"}`;
  });
  h("inputDate", (v) => {
    const p = parts(v);
    return p ? `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : "";
  });
  h("timeAgo", (v) => {
    if (!v) return "";
    const t = v instanceof Date ? v.getTime() : Date.parse(v);
    const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    const p = parts(v);
    return p ? `${MONTHS[p.m]} ${p.d}, ${p.y}` : "";
  });

  // <span class="badge badge--success">Approved</span>
  h("badge", (status) => {
    const key = String(status ?? "");
    const tone = BADGE[key] || "neutral";
    return new hbs.handlebars.SafeString(
      `<span class="badge badge--${tone}">${hbs.handlebars.escapeExpression(humanize(key))}</span>`
    );
  });

  // <option> / checkbox state helpers
  h("selected", (a, b) => (String(a ?? "") === String(b ?? "") ? "selected" : ""));
  h("checked", (a, b) => (String(a ?? "") === String(b ?? "") ? "checked" : ""));

  // JSON for data-* attributes consumed by public/js/charts.js (HTML-escaped by Handlebars)
  h("json", (v) => JSON.stringify(v ?? null));

  // Sortable column header: {{sortTh meta "name" "Employee"}}
  h("sortTh", (meta, key, label) => {
    const state = meta.sortState(key);
    const arrow = state === "asc" ? "▲" : state === "desc" ? "▼" : "↕";
    const aria = state === "asc" ? "ascending" : state === "desc" ? "descending" : "none";
    const esc = hbs.handlebars.escapeExpression;
    return new hbs.handlebars.SafeString(
      `<th scope="col" aria-sort="${aria}"><a class="sort ${state ? "is-sorted" : ""}" href="${esc(meta.sortUrl(key))}">${esc(label)} <span aria-hidden="true">${arrow}</span></a></th>`
    );
  });
}
