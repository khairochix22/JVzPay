// Printing is recorded in the audit trail, whether from a Print button or the browser's own print command.
(() => {
  const box = document.querySelector("[data-session]");
  if (!box) return;
  window.addEventListener("beforeprint", () => {
    const body = new URLSearchParams({ _csrf: box.dataset.csrf || "", page: window.location.pathname + window.location.search, title: document.title });
    window.navigator.sendBeacon("/activity/print", new Blob([body.toString()], { type: "application/x-www-form-urlencoded" }));
  });
  document.addEventListener("click", (e) => { if (e.target.closest("[data-print]")) window.print(); });
})();
