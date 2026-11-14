// Day and dark theme. Loaded in <head> so the saved choice applies before the page first paints.
(() => {
  const KEY = "jvzpay-theme";
  const root = document.documentElement;
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const isDark = () => root.dataset.theme === "dark";

  function syncControls() {
    const label = `Switch to ${isDark() ? "day" : "dark"} theme`;
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-label", label);
      button.title = label;
    });
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isDark() ? "#0B1320" : "#142B4A");
  }

  function apply(theme) {
    root.dataset.theme = theme === "dark" ? "dark" : "light";
    syncControls();
    window.dispatchEvent(new window.CustomEvent("jvzpay:theme")); // charts redraw with the matching palette
  }

  root.dataset.theme = saved() === "dark" ? "dark" : "light";
  document.addEventListener("DOMContentLoaded", syncControls);
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-theme-toggle]")) return;
    const next = isDark() ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch { /* private browsing: the choice lasts for this page only */ }
    apply(next);
  });
  window.addEventListener("storage", (e) => { if (e.key === KEY) apply(e.newValue); }); // other open tabs follow
})();
