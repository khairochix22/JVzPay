// My Schedule: checks every 30 seconds whether anything on the week changed (an overtime or leave decision, a new
// schedule) and reloads the page when it did, so approved overtime appears without the employee refreshing.
(() => {
  const box = document.querySelector("[data-live-schedule]");
  if (!box) return;
  const url = box.getAttribute("data-live-schedule");
  let stamp = box.getAttribute("data-stamp");
  const check = async () => {
    if (document.hidden) return;
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" });
      if (!r.ok) return;
      const j = await r.json();
      if (j.stamp && j.stamp !== stamp) { stamp = j.stamp; window.location.reload(); }
    } catch { /* offline: try again next time */ }
  };
  setInterval(check, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
})();
