// "Select all" checkboxes: <input type="checkbox" data-check-all="ids"> toggles every enabled checkbox named "ids" in its form.
(() => {
  document.querySelectorAll("[data-check-all]").forEach((master) => {
    const name = master.dataset.checkAll;
    const boxes = () => [...(master.form || document).querySelectorAll(`input[type="checkbox"][name="${name}"]:not(:disabled)`)];
    master.addEventListener("change", () => boxes().forEach((b) => { b.checked = master.checked; }));
    document.addEventListener("change", (e) => {
      if (e.target.name !== name) return;
      const all = boxes();
      master.checked = all.length > 0 && all.every((b) => b.checked);
      master.indeterminate = !master.checked && all.some((b) => b.checked);
    });
  });
})();
