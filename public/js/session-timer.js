// Inactivity: warns before the automatic sign-out and signs out when the time is up.
// The last activity time is shared by every open tab through localStorage, so working in one tab keeps the others signed in.
(() => {
  const box = document.querySelector("[data-session]");
  const dialog = document.getElementById("session-dialog");
  if (!box || !dialog) return;
  const KEY = "jvzpay-session-activity";
  const idleMs = Number(box.dataset.idleMs) || 30 * 60 * 1000;
  const warnMs = Math.min(2 * 60 * 1000, idleMs / 3);
  const csrf = box.dataset.csrf || "";
  const left = dialog.querySelector("[data-session-left]");
  const opened = Date.now();
  const mark = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* storage unavailable */ } };
  const last = () => { try { return Number(localStorage.getItem(KEY)) || opened; } catch { return opened; } };
  const post = (url) => fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": csrf }, body: "_csrf=" + encodeURIComponent(csrf) });
  let ended = false;

  async function signOut() {
    if (ended) return;
    ended = true;
    try { await post("/logout"); } catch { /* the session may already be gone */ }
    window.location.replace("/login?expired=1");
  }

  async function stay() {
    try {
      const r = await post("/session/keepalive");
      if (r.status !== 204) return signOut();
      mark();
      dialog.close();
    } catch { /* offline: try again on the next click */ }
  }

  dialog.querySelector("[data-session-stay]").addEventListener("click", stay);
  dialog.querySelector("[data-session-out]").addEventListener("click", signOut);
  mark();
  window.setInterval(() => {
    const remaining = last() + idleMs - Date.now();
    if (remaining <= 0) return signOut();
    if (remaining <= warnMs) {
      const s = Math.ceil(remaining / 1000);
      left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) dialog.close();
  }, 1000);
})();
