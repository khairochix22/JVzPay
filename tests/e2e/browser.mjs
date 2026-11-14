// A small driver for headless Edge or Chrome over the DevTools protocol, so tests use the pages exactly as a person does:
// rendered forms, typing into masked fields, confirmation dialogs and real navigation.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = JSON.stringify;

export async function openBrowser(base) {
  const exe = process.env.E2E_BROWSER || BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) throw new Error("No Edge or Chrome found. Set E2E_BROWSER to the browser's path.");
  const port = 9444 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jvzpay-browser-"));
  const proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let url;
  for (let i = 0; i < 60 && !url; i++) {
    await sleep(250);
    try { url = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch { /* still starting */ }
  }
  if (!url) throw new Error("The browser did not start.");
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const waiters = new Map();
  const problems = [], requests = [];
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiters.has(d.id)) { waiters.get(d.id)(d); waiters.delete(d.id); return; }
    if (d.method === "Network.requestWillBeSent") requests.push(`${d.params.request.method} ${d.params.request.url}`);
    if (d.method === "Runtime.exceptionThrown") problems.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error" && !/favicon/.test(d.params.entry.url || "") && !/status of 4\d\d/.test(d.params.entry.text)) problems.push(d.params.entry.text);
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression, awaitPromise = false) => {
    const d = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (d.error) throw new Error(d.error.message);
    if (d.result.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description || d.result.exceptionDetails.text);
    return d.result.result.value;
  };
  for (const domain of ["Page", "Runtime", "Network", "Log"]) await send(`${domain}.enable`);

  const page = {
    problems,
    requests,
    ev,
    url: () => ev("location.pathname + location.search"),
    text: () => ev("document.body.innerText"),
    has: (selector) => ev(`!!document.querySelector(${S(selector)})`),
    value: (selector) => ev(`document.querySelector(${S(selector)})?.value`),
    viewport: (width, height, mobile) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile }),

    async settle() {
      for (let i = 0; i < 300; i++) {
        await sleep(50);
        let s;
        try { s = await ev("({ old: window.__jvz === 1, ready: document.readyState, dialog: !!document.querySelector('dialog[open] [data-confirm-ok]') })"); } catch { continue; }
        if (s.dialog && s.old) { await ev("document.querySelector('dialog[open] [data-confirm-ok]').click()").catch(() => {}); await sleep(100); continue; }
        if (!s.old && s.ready === "complete") { await sleep(150); return; }
      }
      throw new Error(`The page did not change. It says: ${(await page.messages()).join(" | ") || (await page.text()).slice(0, 200)}`);
    },

    async goto(p) {
      await ev("window.__jvz = 1");
      await send("Page.navigate", { url: base + p });
      await page.settle();
    },

    async set(name, value, scope = "body") {
      const selector = `${scope} [name="${name}"]`;
      const kind = await ev(`(() => { const e = document.querySelector(${S(selector)}); return e ? { tag: e.tagName, type: e.type } : null; })()`);
      if (!kind) throw new Error(`No field named ${name} in ${scope}`);
      if (kind.tag === "SELECT") {
        const ok = await ev(`(() => { const e = document.querySelector(${S(selector)}); const o = [...e.options].find((x) => x.value === ${S(String(value))} || x.text.includes(${S(String(value))})); if (!o) return [...e.options].map((x) => x.text).join(", ") || "(no options)"; e.value = o.value; e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
        if (ok !== true) throw new Error(`${name} has no option "${value}". Options: ${ok}`);
      } else if (["date", "month", "time"].includes(kind.type)) {
        await ev(`(() => { const e = document.querySelector(${S(selector)}); e.value = ${S(String(value))}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      } else {
        await ev(`(() => { const e = document.querySelector(${S(selector)}); e.value = ""; e.focus(); })()`);
        for (const ch of String(value)) await send("Input.insertText", { text: ch }); // one key at a time, so input masks run as they do for a person
      }
    },

    tick: (selector) => ev(`(() => { const e = document.querySelector(${S(selector)}); e.checked = true; e.dispatchEvent(new Event("change", { bubbles: true })); })()`),

    async submit(form, button) {
      await ev("window.__jvz = 1");
      const pick = button ? `f.querySelector(${S(button)})` : "f.querySelector('button[type=submit], button:not([type])')";
      const result = await ev(`(() => { const f = document.querySelector(${S(form)}); if (!f) return "no form"; const b = ${pick}; if (!b) return "no button"; b.click(); return "ok"; })()`);
      if (result !== "ok") throw new Error(`${result}: ${form}`);
      await page.settle();
    },

    async follow(selector) {
      await ev("window.__jvz = 1");
      const href = await ev(`document.querySelector(${S(selector)})?.getAttribute("href")`);
      if (!href) throw new Error(`No link: ${selector}`);
      await send("Page.navigate", { url: base + href });
      await page.settle();
    },

    messages: () => ev("[...document.querySelectorAll('.alert--error, .field__error')].map((e) => e.innerText.trim())"),
    success: () => ev("[...document.querySelectorAll('.alert--success')].map((e) => e.innerText.trim()).join(' ')"),

    async login(email, password) {
      await send("Network.clearBrowserCookies");
      await page.goto("/login");
      await page.set("email", email);
      await page.set("password", password);
      await page.submit('form[action="/login"]');
    },

    async screenshot(file) {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(shot.result.data, "base64"));
    },

    async close() {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); // the browser's own helper processes too
      else proc.kill();
      await sleep(1000);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* the browser may still hold it; it is only a temporary folder */ }
    },
  };
  return page;
}
