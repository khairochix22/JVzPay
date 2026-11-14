// JVzPay charts — Chart.js configured to the data-viz spec:
//  2px lines, bars <= 24px with a 4px rounded data-end, hairline solid grid, one axis (never dual),
//  a legend for >= 2 series, tooltips with the VALUE first, a vertical crosshair on line charts,
//  and a table-view twin for every chart (tooltips enhance, they never gate).
// Series colours follow the ENTITY (series.slot), never its position, so filtering never repaints survivors.
(() => {
  const PALETTES = {
    light: {
      slots: { 1: "#2a78d6", 2: "#eb6834", 3: "#1baf7a", 4: "#eda100", 5: "#e87ba4", 6: "#008300" },
      ink: { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", surface: "#ffffff", tip: "#ffffff", tipBorder: "#e2e8f0" },
    },
    dark: {
      slots: { 1: "#3987e5", 2: "#d95926", 3: "#199e70", 4: "#c98500", 5: "#d55181", 6: "#008300" },
      ink: { primary: "#f0efec", secondary: "#c3c2b7", muted: "#9fb0c7", grid: "#2c3a52", axis: "#44536c", surface: "#182235", tip: "#1f2b40", tipBorder: "#44536c" },
    },
  };
  let SLOTS, INK;
  const usePalette = () => ({ slots: SLOTS, ink: INK } = PALETTES[document.documentElement.dataset.theme === "dark" ? "dark" : "light"]);
  usePalette();
  // WCAG contrast of a label colour on a fill; a share is printed inside a segment only when its ink reaches 4.5:1
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const inkOn = (fill) => {
    const white = contrast("#ffffff", fill), dark = contrast("#0b0b0b", fill);
    return Math.max(white, dark) >= 4.5 ? (dark > white ? "dark" : "light") : null;
  };

  const money = (v) => "₱" + Number(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const axisMoney = (v) => {
    const a = Math.abs(v);
    if (a >= 1e6) return "₱" + +(v / 1e6).toFixed(1) + "M";
    if (a >= 1e4) return "₱" + +(v / 1e3).toFixed(1) + "K";
    return "₱" + v.toLocaleString("en-PH");
  };
  const isRound = (cfg) => cfg.kind === "doughnut" || cfg.kind === "pie";
  const fmt = (cfg) => (cfg.format === "money" ? money : (v) => Number(v).toLocaleString("en-PH"));
  const axisFmt = (cfg) => (cfg.format === "money" ? axisMoney : (v) => Number(v).toLocaleString("en-PH"));
  const color = (s) => SLOTS[s.slot || 1];
  const alpha = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // labels are data: never innerHTML
    return e;
  }

  // ------------------------------------------------------------------ shared: legend + table twin + empty state
  function buildLegend(card, cfg) {
    const ul = card.querySelector("[data-legend]");
    if (!ul) return;
    ul.textContent = "";
    if (isRound(cfg)) {
      ul.classList.add("chart-legend--bar");
      cfg.labels.forEach((name, i) => {
        const li = el("li");
        const sw = el("i"); sw.style.background = SLOTS[cfg.slots[i]];
        li.append(sw, el("span", "", name));
        ul.append(li);
      });
      return;
    }
    if (cfg.series.length < 2) { ul.hidden = true; return; } // a single series needs no legend; the title names it
    ul.classList.toggle("chart-legend--bar", cfg.kind !== "line"); // legend key mirrors the mark: line for lines, square for bars/blocks
    // a segmented bar prints its shares in the legend, so a part too small (or too low-contrast) for an inside label still shows it
    const segTotal = cfg.kind === "segments" ? cfg.series.reduce((a, s) => a + Number(s.data[0] || 0), 0) : 0;
    cfg.series.forEach((s) => {
      const li = el("li");
      const sw = el("i"); sw.style.background = color(s);
      li.append(sw, el("span", "", s.name));
      if (segTotal) li.append(el("span", "muted", `${Math.round((Number(s.data[0] || 0) / segTotal) * 100)}%`));
      ul.append(li);
    });
  }

  function buildTable(card, cfg) {
    const wrap = card.querySelector("[data-viz-table]");
    if (!wrap) return;
    wrap.textContent = "";
    const t = el("table", "viz-table");
    const head = el("tr");
    head.append(el("th", "", cfg.xLabel || "Period"));
    cfg.series.forEach((s) => head.append(el("th", "v", s.name)));
    const thead = el("thead");
    thead.append(head);
    t.append(thead);
    const tb = el("tbody");
    cfg.labels.forEach((lab, i) => {
      const r = el("tr");
      r.append(el("td", "", lab));
      cfg.series.forEach((s) => r.append(el("td", "v", s.data[i] === null ? "—" : fmt(cfg)(s.data[i] ?? 0))));
      tb.append(r);
    });
    t.append(tb);
    wrap.append(t);
  }

  function wireToggle(card) {
    const btns = card.querySelectorAll("[data-view]");
    btns.forEach((b) =>
      b.addEventListener("click", () => {
        const table = b.dataset.view === "table";
        card.classList.toggle("show-table", table);
        btns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        if (!table) card.querySelector("canvas")?.dispatchEvent(new Event("resize"));
      })
    );
  }

  const hasData = (cfg) => cfg.series.some((s) => s.data.some((v) => Number(v) !== 0));

  // ------------------------------------------------------------------ Chart.js line / bar
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      if (chart.config.type !== "line") return;
      const a = chart.tooltip?.getActiveElements?.() || [];
      if (!a.length) return;
      const { ctx, chartArea } = chart;
      const x = a[0].element.x;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom);
      ctx.lineWidth = 1; ctx.strokeStyle = INK.axis; ctx.stroke();
      ctx.restore();
    },
  };

  function renderChartJs(card, cfg) {
    const canvas = card.querySelector("canvas");
    const isLine = cfg.kind === "line";
    const datasets = cfg.series.map((s) => {
      const c = color(s);
      return isLine
        ? {
            label: s.name, data: s.data, borderColor: c, backgroundColor: alpha(c, 0.1), fill: cfg.series.length === 1,
            borderWidth: 2, tension: 0, borderJoinStyle: "round", borderCapStyle: "round", borderDash: s.dashed ? [6, 4] : [],
            pointRadius: cfg.labels.length > 12 ? 0 : 3, pointHoverRadius: 5, pointBackgroundColor: c, pointBorderColor: INK.surface, pointBorderWidth: 2,
            pointHitRadius: 24,
          }
        : {
            label: s.name, data: s.data, backgroundColor: c, hoverBackgroundColor: alpha(c, 0.82),
            borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 }, borderSkipped: false,
            maxBarThickness: 24, borderColor: INK.surface, borderWidth: { left: 1, right: 1, top: 0, bottom: 0 },
          };
    });
    new Chart(canvas, {
      type: isLine ? "line" : "bar",
      data: { labels: cfg.labels, datasets },
      plugins: [crosshair],
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 8, right: 8 } },
        scales: {
          x: { grid: { display: false }, border: { color: INK.axis }, ticks: { color: INK.muted, font: { size: 12 }, maxRotation: cfg.xLabel === "Month" ? 0 : 45, autoSkip: cfg.xLabel === "Month", autoSkipPadding: 12 } },
          y: {
            beginAtZero: true, border: { display: false },
            grid: { color: INK.grid, lineWidth: 1 }, ticks: { color: INK.muted, font: { size: 12 }, callback: axisFmt(cfg), maxTicksLimit: 6, precision: cfg.format === "money" ? undefined : 0 },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: INK.tip, titleColor: INK.secondary, bodyColor: INK.primary, borderColor: INK.tipBorder, borderWidth: 1,
            padding: 10, cornerRadius: 8, boxWidth: 12, boxHeight: 3, usePointStyle: false, displayColors: true,
            titleFont: { weight: "500", size: 12 }, bodyFont: { weight: "600", size: 13 },
            callbacks: {
              // value first, series name after (the reader already has the series, they want the number)
              label: (ctx) => ` ${fmt(cfg)(ctx.parsed.y)}   ${cfg.series.length > 1 ? ctx.dataset.label : ""}`.trimEnd(),
              labelColor: (ctx) => ({ borderColor: ctx.dataset.borderColor || ctx.dataset.backgroundColor, backgroundColor: ctx.dataset.borderColor || ctx.dataset.backgroundColor, borderRadius: 1 }),
            },
          },
        },
      },
    });
  }

  // part-to-whole for up to 6 components; the legend and table view carry every value
  function renderDoughnut(card, cfg) {
    const total = cfg.series[0].data.reduce((a, b) => a + Number(b), 0);
    new Chart(card.querySelector("canvas"), {
      type: cfg.kind,
      data: { labels: cfg.labels, datasets: [{ data: cfg.series[0].data, backgroundColor: cfg.slots.map((s) => SLOTS[s]), borderColor: INK.surface, borderWidth: cfg.series[0].data.filter(Number).length > 1 ? 2 : 0, hoverOffset: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: cfg.kind === "pie" ? 0 : "62%", animation: { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: INK.tip, titleColor: INK.secondary, bodyColor: INK.primary, borderColor: INK.tipBorder, borderWidth: 1, padding: 10, cornerRadius: 8, displayColors: false,
            bodyFont: { weight: "600", size: 13 },
            callbacks: { title: (items) => items[0]?.label || "", label: (ctx) => `${fmt(cfg)(ctx.parsed)} (${total ? Math.round((ctx.parsed / total) * 100) : 0}%)` },
          },
        },
      },
    });
  }

  // ------------------------------------------------------------------ tall segmented bar (part-to-whole, <= 6 parts)
  function renderSegments(card, cfg) {
    const host = card.querySelector("[data-segbar]");
    host.textContent = "";
    const parts = cfg.series.map((s) => ({ ...s, value: Number(s.data[0] || 0) })).filter((p) => p.value > 0); // zero parts draw nothing
    const total = parts.reduce((a, p) => a + p.value, 0);
    const summary = cfg.series.map((s) => `${s.name}: ${s.data[0] || 0}`).join(", ");
    const bar = el("div", "segbar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${cfg.title}. ${summary}`);
    bar.tabIndex = 0;
    host.append(bar);

    const tip = document.getElementById("viz-tip");
    const showTip = (p, x, y) => {
      if (!tip) return;
      tip.textContent = "";
      const b = el("b", "", `${p.value.toLocaleString("en-PH")} (${Math.round((p.value / total) * 100)}%)`);
      tip.append(b, document.createTextNode("  " + p.name));
      tip.hidden = false; tip.style.left = Math.min(x + 12, innerWidth - 250) + "px"; tip.style.top = y + 14 + "px";
    };
    parts.forEach((p) => {
      const c = color(p);
      const ink = inkOn(c);
      const d = el("div", "segbar__part" + (ink === "dark" ? " segbar__part--dark-ink" : ""));
      d.style.background = c; d.style.flex = `${p.value} 1 0`;
      if (ink) d.dataset.label = `${Math.round((p.value / total) * 100)}%`;
      d.addEventListener("pointermove", (e) => showTip(p, e.clientX, e.clientY));
      d.addEventListener("pointerleave", () => tip && (tip.hidden = true));
      bar.append(d);
    });
    // print the share inside a part only when it fits with padding on both sides; otherwise the table view/legend carry it
    requestAnimationFrame(() => {
      const probe = el("span"); probe.style.cssText = "position:absolute;visibility:hidden;font:650 12.5px system-ui";
      document.body.append(probe);
      bar.querySelectorAll(".segbar__part[data-label]").forEach((d) => {
        probe.textContent = d.dataset.label;
        if (probe.offsetWidth + 20 <= d.clientWidth) d.textContent = d.dataset.label;
      });
      probe.remove();
    });
    if (!parts.length) host.replaceChildren(el("div", "segbar-empty"));
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    if (!document.getElementById("viz-tip")) {
      const t = el("div", "viz-tip"); t.id = "viz-tip"; t.hidden = true; document.body.append(t);
    }
    document.querySelectorAll("[data-chart]").forEach((card) => {
      let cfg;
      try { cfg = JSON.parse(card.dataset.chart); } catch { return; }
      if (!hasData(cfg)) { card.classList.add("is-empty"); return; } // never draw a chart of nothing
      buildTable(card, cfg);
      wireToggle(card);
      draw(card, cfg);
    });
  }

  function draw(card, cfg) {
    buildLegend(card, cfg);
    if (cfg.kind === "segments") renderSegments(card, cfg);
    else if (window.Chart && isRound(cfg)) renderDoughnut(card, cfg);
    else if (window.Chart) renderChartJs(card, cfg);
  }

  // the theme toggle repaints every chart with the palette validated for that surface
  window.addEventListener("jvzpay:theme", () => {
    usePalette();
    document.querySelectorAll("[data-chart]:not(.is-empty)").forEach((card) => {
      let cfg;
      try { cfg = JSON.parse(card.dataset.chart); } catch { return; }
      const canvas = card.querySelector("canvas");
      if (canvas && window.Chart) window.Chart.getChart(canvas)?.destroy();
      draw(card, cfg);
    });
  });
  document.addEventListener("DOMContentLoaded", boot);
})();
