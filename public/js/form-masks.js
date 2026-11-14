// Input masks: <input data-mask="sss"> formats the number as it is typed. The server still validates every value.
(() => {
  const GROUPS = { sss: [2, 7, 1], philhealth: [2, 9, 1], pagibig: [4, 4, 4], tin: [3, 3, 3, 5] };

  function grouped(digits, sizes, separator) {
    const parts = [];
    let at = 0;
    for (const size of sizes) {
      if (at >= digits.length) break;
      parts.push(digits.slice(at, at + size));
      at += size;
    }
    return parts.join(separator);
  }

  const FORMAT = {
    digits: (v) => v.replace(/\D/g, ""),
    // Philippine mobile numbers are grouped 09XX XXX XXXX; landlines and +63 numbers are left as typed
    phone: (v) => {
      const digits = v.replace(/\D/g, "");
      return /^09/.test(digits) && !v.trim().startsWith("+") ? grouped(digits.slice(0, 11), [4, 3, 4], " ") : v.replace(/[^\d+()\s-]/g, "");
    },
  };
  for (const [name, sizes] of Object.entries(GROUPS)) {
    FORMAT[name] = (v) => grouped(v.replace(/\D/g, "").slice(0, sizes.reduce((a, b) => a + b, 0)), sizes, "-");
  }

  function apply(input, format) {
    const before = input.value;
    const caret = input.selectionStart ?? before.length;
    const digitsBeforeCaret = before.slice(0, caret).replace(/\D/g, "").length;
    const after = format(before);
    if (after === before) return;
    input.value = after;
    if (caret >= before.length) return; // typing at the end: the browser already leaves the caret at the end
    let position = 0;
    for (let seen = 0; position < after.length && seen < digitsBeforeCaret; position++) if (/\d/.test(after[position])) seen++;
    input.setSelectionRange(position, position);
  }

  document.querySelectorAll("input[data-mask]").forEach((input) => {
    const format = FORMAT[input.dataset.mask];
    if (!format) return;
    input.addEventListener("input", () => apply(input, format));
    if (input.value) input.value = format(input.value);
  });
})();
