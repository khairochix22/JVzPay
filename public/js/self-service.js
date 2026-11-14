// Progressive enhancement for self-service forms (everything still works without JS).
(() => {
  // Bank: show "Bank name (if Other)" only when Other is selected; GCash/Maya imply the E-wallet type.
  const bank = document.querySelector("[data-bank-select]");
  const other = document.querySelector("[data-bank-other]");
  const type = document.getElementById("account_type");
  if (bank && other) {
    const sync = () => {
      other.hidden = bank.value !== "Other";
      if (type && (bank.value === "GCash" || bank.value === "Maya")) type.value = "e_wallet";
    };
    bank.addEventListener("change", sync);
    sync();
  }
})();
