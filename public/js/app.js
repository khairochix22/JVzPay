// JVzPay shell behaviour — no inline scripts anywhere (strict CSP).
(() => {
  const body = document.body;
  const KEY = "jvzpay.sidebar";

  // ---- sidebar: collapsible on desktop (remembered), drawer on phones ---------------------------------------------------------
  if (localStorage.getItem(KEY) === "collapsed") body.classList.add("sidebar-collapsed");
  document.querySelectorAll("[data-sidebar-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const collapsed = body.classList.toggle("sidebar-collapsed");
      localStorage.setItem(KEY, collapsed ? "collapsed" : "expanded");
      b.setAttribute("aria-expanded", String(!collapsed));
    })
  );
  // sidebar sections open and close; the one holding the current page is opened by the server, the rest are remembered here
  const NAV_KEY = "jvzpay.nav-open";
  let openSecs;
  try { openSecs = new Set(JSON.parse(localStorage.getItem(NAV_KEY) || "[]")); } catch { openSecs = new Set(); }
  document.querySelectorAll("[data-nav-sec]").forEach((sec) => {
    const btn = sec.querySelector("[data-nav-toggle]");
    const setOpen = (open) => { sec.classList.toggle("is-open", open); btn.setAttribute("aria-expanded", String(open)); };
    if (openSecs.has(sec.dataset.navSec)) setOpen(true);
    btn.addEventListener("click", () => {
      const open = !sec.classList.contains("is-open");
      setOpen(open);
      if (open) openSecs.add(sec.dataset.navSec); else openSecs.delete(sec.dataset.navSec);
      try { localStorage.setItem(NAV_KEY, JSON.stringify([...openSecs])); } catch { /* storage full or blocked: the choice just is not kept */ }
    });
  });
  const closeDrawer = () => body.classList.remove("drawer-open");
  document.querySelectorAll("[data-drawer-open]").forEach((b) => b.addEventListener("click", () => body.classList.add("drawer-open")));
  document.querySelectorAll("[data-drawer-close]").forEach((b) => b.addEventListener("click", closeDrawer));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); closeMenus(); } });

  // ---- dropdown menus -----------------------------------------------------------------------------------------------------------
  function closeMenus(except) {
    document.querySelectorAll(".menu.is-open").forEach((m) => { if (m !== except) { m.classList.remove("is-open"); m.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false"); } });
  }
  document.querySelectorAll("[data-menu-toggle]").forEach((t) =>
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = t.closest(".menu");
      closeMenus(menu);
      const open = menu.classList.toggle("is-open");
      t.setAttribute("aria-expanded", String(open));
    })
  );
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closeMenus(); });

  // ---- confirmation dialogs: <form data-confirm="Message" data-confirm-label="Approve" data-confirm-tone="danger"> ----------
  const dlg = document.getElementById("confirm-dialog");
  if (dlg) {
    let pending = null;
    document.addEventListener("submit", (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !form.dataset.confirm || form.dataset.confirmed === "1") return;
      e.preventDefault();
      pending = form;
      dlg.querySelector("[data-confirm-title]").textContent = form.dataset.confirmTitle || "Please confirm";
      dlg.querySelector("[data-confirm-message]").textContent = form.dataset.confirm;
      const ok = dlg.querySelector("[data-confirm-ok]");
      ok.textContent = form.dataset.confirmLabel || "Confirm";
      ok.className = "btn " + (form.dataset.confirmTone === "danger" ? "btn--danger" : "btn--primary");
      dlg.showModal();
    });
    dlg.querySelector("[data-confirm-ok]").addEventListener("click", () => {
      dlg.close();
      if (pending) { pending.dataset.confirmed = "1"; pending.requestSubmit(); pending = null; }
    });
    dlg.querySelector("[data-confirm-cancel]").addEventListener("click", () => { dlg.close(); pending = null; });
  }

  // ---- double-submit protection + loading state -------------------------------------------------------------------------------
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || e.defaultPrevented) return;
    if (form.dataset.confirm && form.dataset.confirmed !== "1") return;
    const btn = form.querySelector('button[type="submit"]:not([data-no-loading])');
    if (btn) { btn.classList.add("is-loading"); btn.setAttribute("aria-busy", "true"); }
  });
  window.addEventListener("pageshow", () => document.querySelectorAll(".btn.is-loading").forEach((b) => b.classList.remove("is-loading")));

  // ---- live-search tables: debounce typing then submit the GET form -------------------------------------------------------------
  document.querySelectorAll("input[data-autosubmit]").forEach((input) => {
    let t;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => input.form.requestSubmit(), 450);
    });
  });
  document.querySelectorAll("select[data-autosubmit]").forEach((s) => s.addEventListener("change", () => s.form.requestSubmit()));
  // keep caret at end after the page reloads from a search
  const q = document.querySelector("input[data-autosubmit][name='q']");
  if (q && q.value) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }

  // ---- show/hide password (an eye icon inside the field, or a text button) --------------------------------------------------------
  document.querySelectorAll("[data-toggle-password]").forEach((b) =>
    b.addEventListener("click", () => {
      const input = document.getElementById(b.dataset.togglePassword);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.setAttribute("aria-pressed", String(show));
      const use = b.querySelector("use");
      if (use) {
        use.setAttribute("href", show ? "#i-eye-off" : "#i-eye");
        b.setAttribute("aria-label", show ? "Hide password" : "Show password");
      } else b.textContent = show ? "Hide" : "Show";
    })
  );

  // ---- sign-in: remember the email address on this device (never the password) ------------------------------------------------
  const remember = document.getElementById("remember-email");
  if (remember) {
    const EMAIL_KEY = "jvzpay.remember-email";
    const email = document.getElementById("email");
    const saved = localStorage.getItem(EMAIL_KEY);
    if (saved) {
      remember.checked = true;
      if (!email.value) { email.value = saved; document.getElementById("password")?.focus(); }
    }
    remember.form.addEventListener("submit", () => {
      try {
        if (remember.checked && email.value.trim()) localStorage.setItem(EMAIL_KEY, email.value.trim());
        else localStorage.removeItem(EMAIL_KEY);
      } catch { /* storage blocked: nothing to remember */ }
    });
  }

  // ---- top-bar search: finds the pages in this user's sidebar and the reports they may open ------------------------------------
  const search = document.querySelector("[data-page-search]");
  if (search) {
    const input = search.querySelector("input");
    const list = search.querySelector(".search-box__results");
    const seen = new Set();
    const index = [
      ...[...document.querySelectorAll(".sidebar .nav-link")].map((a) => ({ label: a.querySelector(".label").textContent.trim(), group: a.closest("[data-nav-sec]")?.dataset.navSec || "Pages", href: a.getAttribute("href") })),
      ...[...search.querySelectorAll("[data-search-extra] li")].map((li) => ({ label: li.textContent.trim(), group: li.dataset.group, href: li.dataset.href })),
    ].filter((it) => !seen.has(it.href) && seen.add(it.href));
    const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    let hits = [];
    let cur = -1;
    const render = () => {
      list.textContent = "";
      hits.forEach((h, i) => {
        const li = document.createElement("li");
        li.id = `page-search-${i}`;
        li.className = "search-box__hit" + (i === cur ? " is-current" : "");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === cur));
        const a = document.createElement("a");
        a.href = h.href;
        a.tabIndex = -1;
        const name = document.createElement("strong");
        name.textContent = h.label;
        const where = document.createElement("span");
        where.textContent = h.group;
        a.append(name, where);
        li.append(a);
        list.append(li);
      });
      const q = input.value.trim();
      if (q && !hits.length) {
        const li = document.createElement("li");
        li.className = "search-box__none";
        li.textContent = `No page or report matches “${q}”.`;
        list.append(li);
      }
      list.hidden = !q;
      input.setAttribute("aria-expanded", String(!list.hidden));
      if (cur >= 0) input.setAttribute("aria-activedescendant", `page-search-${cur}`);
      else input.removeAttribute("aria-activedescendant");
    };
    const find = () => {
      const words = norm(input.value).split(/\s+/).filter(Boolean);
      hits = !words.length ? [] : index
        .map((it) => {
          const name = norm(it.label);
          if (!words.every((w) => `${name} ${norm(it.group)}`.includes(w))) return null;
          return { ...it, score: name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2 };
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
        .slice(0, 8);
      cur = hits.length ? 0 : -1;
      render();
    };
    input.addEventListener("input", find);
    input.addEventListener("focus", () => { if (input.value.trim()) find(); });
    input.addEventListener("blur", () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); });
    list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box so the click lands on the link
    input.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) {
        e.preventDefault();
        cur = (cur + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
        render();
      } else if (e.key === "Enter" && cur >= 0) {
        e.preventDefault();
        window.location.href = hits[cur].href;
      } else if (e.key === "Escape") {
        input.value = "";
        find();
      }
    });
    // "/" jumps to the search box from anywhere except a field the user is typing in
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      input.focus();
    });
  }

  // ---- dismissible flash messages ---------------------------------------------------------------------------------------------------
  document.querySelectorAll(".alert[data-autohide]").forEach((a) => setTimeout(() => a.remove(), 7000));
})();
