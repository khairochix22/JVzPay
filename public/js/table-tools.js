// Search, status filter, column sorting and paging for short lists sent to the browser whole: <table data-table-tools>.
// Long lists (employees, payroll batches, audit...) are searched and paged on the server instead.
// Also shows a loading state on any table while a server-side search, sort or page change is in progress.
(() => {
  const PAGE_SIZE = 10;
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const cellText = (cell) => clean(cell?.dataset.sort ?? cell?.textContent);

  function sortValue(raw) {
    if (!raw || raw === "—") return null;
    if (/^-?\s*[₱$]?\s*-?[\d,]+(\.\d+)?\s*%?$/.test(raw)) return Number(raw.replace(/[^\d.-]/g, ""));
    if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(raw) || /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) return t;
    }
    return raw.toLowerCase();
  }

  function compare(a, b) {
    if (a === null) return b === null ? 0 : 1; // blanks always last
    if (b === null) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), "en", { numeric: true });
  }

  const make = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function enhance(table) {
    const body = table.tBodies[0];
    if (!body || !body.rows.length) return;
    const rows = [...body.rows];
    const original = rows.slice();
    const wrap = table.closest(".table-wrap") || table;
    const headers = table.tHead ? [...table.tHead.rows[0].cells] : [];
    const state = { term: "", status: "", column: -1, dir: 1, page: 1 };

    // ---- toolbar
    const bar = make("div", "toolbar table-tools");
    const search = make("input", "input");
    search.type = "search";
    search.placeholder = "Search this list";
    search.setAttribute("aria-label", "Search this list");
    const group = make("div", "input-group search");
    group.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>'; // static markup, no data
    group.append(search);
    bar.append(group);

    // the first column showing status badges becomes a filter
    const statusColumn = headers.findIndex((_, i) => rows.some((r) => r.cells[i]?.querySelector(".badge")));
    let select;
    if (statusColumn >= 0) {
      const values = [...new Set(rows.map((r) => clean(r.cells[statusColumn]?.querySelector(".badge")?.textContent)).filter(Boolean))].sort();
      select = make("select", "select");
      select.setAttribute("aria-label", "Filter by status");
      select.append(new window.Option("All statuses", ""), ...values.map((v) => new window.Option(v, v)));
      bar.append(select);
    }
    wrap.before(bar);

    // ---- column sorting
    headers.forEach((th, i) => {
      if (th.classList.contains("actions") || !clean(th.textContent) || th.querySelector("a,button,input")) return;
      const label = clean(th.textContent);
      const btn = make("button", "sort", label);
      btn.type = "button";
      const arrow = make("span", "", " ↕");
      arrow.setAttribute("aria-hidden", "true");
      btn.append(arrow);
      th.textContent = "";
      th.append(btn);
      th.setAttribute("aria-sort", "none");
      btn.addEventListener("click", () => {
        state.dir = state.column === i ? -state.dir : 1;
        state.column = i;
        state.page = 1;
        headers.forEach((h, k) => {
          if (!h.hasAttribute("aria-sort")) return;
          h.setAttribute("aria-sort", k === i ? (state.dir > 0 ? "ascending" : "descending") : "none");
          const a = h.querySelector(".sort span");
          if (a) a.textContent = k === i ? (state.dir > 0 ? " ▲" : " ▼") : " ↕";
          h.querySelector(".sort")?.classList.toggle("is-sorted", k === i);
        });
        render();
      });
    });

    // ---- pager and "no matches" message
    const footer = make("div", "pager table-tools__pager");
    const summary = make("div");
    summary.setAttribute("aria-live", "polite");
    const nav = make("div", "table-tools__nav");
    const prev = make("button", "btn btn--secondary btn--sm", "Previous");
    const next = make("button", "btn btn--secondary btn--sm", "Next");
    prev.type = next.type = "button";
    nav.append(prev, next);
    footer.append(summary, nav);
    const none = make("div", "empty empty--sm", "No matching records.");
    none.hidden = true;
    wrap.after(none, footer);

    function render() {
      const term = state.term.toLowerCase();
      const matches = rows.filter((r) => {
        if (term && !clean(r.textContent).toLowerCase().includes(term)) return false;
        return !state.status || clean(r.cells[statusColumn]?.querySelector(".badge")?.textContent) === state.status;
      });
      if (state.column >= 0) {
        matches.sort((a, b) => {
          const x = sortValue(cellText(a.cells[state.column])), y = sortValue(cellText(b.cells[state.column]));
          if (x === null || y === null) return compare(x, y); // blanks stay last in both directions
          return compare(x, y) * state.dir;
        });
      }
      const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
      state.page = Math.min(state.page, pages);
      const from = (state.page - 1) * PAGE_SIZE;
      const visible = new Set(matches.slice(from, from + PAGE_SIZE));
      // sorted matches first, everything else keeps its original order behind them
      const order = state.column >= 0 ? [...matches, ...original.filter((r) => !matches.includes(r))] : original;
      order.forEach((r) => { body.append(r); r.hidden = !visible.has(r); });

      none.hidden = matches.length > 0;
      wrap.hidden = matches.length === 0;
      summary.textContent = matches.length ? `Showing ${from + 1}–${Math.min(from + PAGE_SIZE, matches.length)} of ${matches.length}` : "Showing 0 records";
      nav.hidden = pages <= 1;
      prev.disabled = state.page <= 1;
      next.disabled = state.page >= pages;
    }

    search.addEventListener("input", () => { state.term = search.value.trim(); state.page = 1; render(); });
    select?.addEventListener("change", () => { state.status = select.value; state.page = 1; render(); });
    prev.addEventListener("click", () => { state.page -= 1; render(); });
    next.addEventListener("click", () => { state.page += 1; render(); });
    render();
  }

  document.querySelectorAll("table[data-table-tools]").forEach(enhance);

  // ---- loading state while the server prepares a new page of results
  const setBusy = (on) => document.querySelectorAll(".table-wrap").forEach((w) => {
    w.classList.toggle("is-refreshing", on);
    if (on) w.setAttribute("aria-busy", "true"); else w.removeAttribute("aria-busy");
  });
  document.addEventListener("submit", (e) => { if ((e.target.getAttribute("method") || "get").toLowerCase() === "get") setBusy(true); });
  document.addEventListener("click", (e) => { if (e.target.closest(".pager a, a.sort")) setBusy(true); });
  window.addEventListener("pageshow", () => setBusy(false));
})();
