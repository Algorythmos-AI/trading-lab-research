// The Options page's responsiveness, measured in a real Chrome: long tasks, a 50 ms heartbeat (how long the page could
// not answer), React commits a second (through the DevTools hook React looks for), the timers the page runs, heap and
// DOM size, and real clicks on the rail's controls with how long each took to take effect. Read only: with
// --block-writes on, every request that is not a GET or HEAD is answered 503 in the browser and never sent.
//
// Not part of CI (timing depends on the machine); the deterministic guards are test/e2e/responsiveness.spec.ts.
//   node scripts/perf-probe.mjs --base http://127.0.0.1:3100 --secs 90 --cpu 4 --cockpit on --out run.json
//   (fixture server: DASHBOARD_FIXTURE=1 pnpm start; --fx sets the fixture cookie, default the scripted session)
//   Against a deployment behind Vercel Authentication: --fx none --bypass-env <.env with VERCEL_AUTOMATION_BYPASS_SECRET>
//   --block-writes on. The secret is read from the file and never printed.
// Uses the installed Google Chrome (channel "chrome"), headless, with a fresh profile.
import { createRequire } from "node:module";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []),
);
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const base = args.base ?? "http://127.0.0.1:3200";
const secs = Number(args.secs ?? 120);
const cpu = Number(args.cpu ?? 1);
const cockpit = (args.cockpit ?? "on") === "on";
const fx = args.fx ?? "focus.quotes-script";
const step = args.step;
const path = args.path ?? "/options";
const clicks = (args.clicks ?? "on") === "on";

const INIT = `
(() => {
  const s = (window.__probe = { longtasks: [], events: [], commits: 0, commitTimes: [], lags: [], errors: [] });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); })
      .observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "click" || e.name === "pointerdown" || e.name === "keydown")
      s.events.push([e.name, Math.round(e.startTime), Math.round(e.duration), Math.round(e.processingStart - e.startTime)]); })
      .observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
  // React commits, through the DevTools hook React looks for at start-up.
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(r) { const i = ++id; this.renderers.set(i, r); return i; },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
    onCommitFiberRoot() { s.commits++; s.commitTimes.push(Math.round(performance.now())); },
  };
  const liveIv = new Map(); let ivMade = 0;
  const _si = window.setInterval, _ci = window.clearInterval;
  window.setInterval = function (fn, ms, ...r) { const id = _si.call(window, fn, ms, ...r); liveIv.set(id, ms); ivMade++; return id; };
  window.clearInterval = function (id) { liveIv.delete(id); return _ci.call(window, id); };
  s.intervals = () => ({ made: ivMade, live: [...liveIv.values()].reduce((a, ms) => ((a[ms] = (a[ms] ?? 0) + 1), a), {}) });
  // A 50 ms heartbeat: how late each beat runs is how long the main thread was busy.
  let last = performance.now();
  const beat = () => { const n = performance.now(); const lag = n - last - 50; if (lag > 50) s.lags.push([Math.round(last), Math.round(lag)]); last = n; setTimeout(beat, 50); };
  setTimeout(beat, 50);
  window.addEventListener("error", (e) => s.errors.push(String(e.message)));
  ${cockpit ? `try { localStorage.setItem("options-cockpit", "on"); } catch {}` : `try { localStorage.removeItem("options-cockpit"); } catch {}`}
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: () => Promise.resolve({ release: () => Promise.resolve(), addEventListener: () => undefined }) } });
})();
`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
// --bypass-env FILE: read VERCEL_AUTOMATION_BYPASS_SECRET from that .env (never printed) and send it as the bypass header.
let extraHTTPHeaders;
if (args["bypass-env"]) {
  const line = fs.readFileSync(args["bypass-env"], "utf8").split("\n").find((l) => l.startsWith("VERCEL_AUTOMATION_BYPASS_SECRET="));
  const secret = line ? line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "").trim() : "";
  if (!secret) throw new Error("no bypass secret in " + args["bypass-env"]);
  extraHTTPHeaders = { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" };
}
const context = await browser.newContext({ viewport: { width: 1512, height: 900 }, ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}) });
if (fx !== "none") {
  const cookies = [{ name: "fx", value: fx, url: base }];
  if (step) cookies.push({ name: "fxstep", value: String(step), url: base });
  await context.addCookies(cookies);
}
// --block-writes on: every request that is not a GET or HEAD is answered 503 here and never leaves the browser.
const blocked = [];
const requests = { n: 0, byPath: {} };
if ((args["block-writes"] ?? "off") === "on") {
  await context.route("**/*", (route) => {
    const r = route.request();
    if (r.method() !== "GET" && r.method() !== "HEAD") {
      blocked.push(`${r.method()} ${new URL(r.url()).pathname}`);
      return route.fulfill({ status: 503, body: "blocked by probe" });
    }
    return route.continue();
  });
}
await context.addInitScript(INIT);
const page = await context.newPage();
page.on("requestfinished", (r) => { try { const u = new URL(r.url()); if (u.origin === new URL(base).origin && u.pathname.startsWith("/api/")) { requests.n++; requests.byPath[u.pathname] = (requests.byPath[u.pathname] ?? 0) + 1; } } catch {} });
const slow = [];
page.on("requestfinished", async (r) => { try { const t = r.timing(); const ms = t.responseEnd; if (ms > 3000 && new URL(r.url()).pathname.startsWith("/api/")) slow.push([new URL(r.url()).pathname, Math.round(ms)]); } catch {} });
page.on("requestfailed", (r) => { try { slow.push([new URL(r.url()).pathname, "failed: " + (r.failure()?.errorText ?? "")]); } catch {} });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });

const t0 = Date.now();
await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 120_000 });
const samples = [];
const clickLog = [];
// Controls that should answer at once, in turn. Each records how long the click call took and whether it took effect.
const targets = [
  { name: "alerts", sel: 'button:has-text("Alerts"):visible', check: "#trade-now-alerts", close: "Escape" },
  { name: "today-log", sel: "[data-today-log-button]:visible", check: "#today-log", close: "Escape" },
  { name: "cockpit", sel: "[data-cockpit-switch]:visible", check: null, close: null, toggle: true },
];
let k = 0;
let nextSample = 0;
while (Date.now() - t0 < secs * 1000) {
  const el = Date.now() - t0;
  if (el >= nextSample) {
    nextSample += 5000;
    try {
      const m = await cdp.send("Performance.getMetrics");
      const get = (n) => m.metrics.find((x) => x.name === n)?.value ?? null;
      const price = await page.evaluate(() => document.querySelector("[data-cockpit-ladders], [data-trade-now]")?.textContent?.slice(0, 400) ?? "").catch(() => "");
      samples.push({ t: el, heapMB: Math.round(get("JSHeapUsedSize") / 1e5) / 10, nodes: get("Nodes"), listeners: get("JSEventListeners"), taskS: get("TaskDuration"), scriptS: get("ScriptDuration"), layoutS: get("LayoutDuration"), recalcS: get("RecalcStyleDuration"), sig: price.length ? hash(price) : null });
    } catch (e) {
      samples.push({ t: el, err: String(e).slice(0, 120) });
    }
  }
  if (clicks && el > 8000) {
    const tg = targets[k++ % targets.length];
    const s = Date.now();
    let ok = false, err = null;
    try {
      const loc = page.locator(tg.sel).first();
      const before = tg.toggle ? await loc.getAttribute("aria-pressed", { timeout: 15_000 }) : null;
      await loc.click({ timeout: 15_000 });
      if (tg.toggle) {
        await page.waitForFunction(([sel, b]) => [...document.querySelectorAll(sel)].some((e) => e.getAttribute("aria-pressed") !== b), ["[data-cockpit-switch]", before], { timeout: 15_000 });
        // back as it was, so the cockpit stays as the run asked
        await page.locator(tg.sel).first().click({ timeout: 15_000 });
      } else {
        await page.locator(tg.check).first().waitFor({ state: "visible", timeout: 15_000 });
        await page.keyboard.press(tg.close);
      }
      ok = true;
    } catch (e) {
      err = String(e).split("\n")[0].slice(0, 160);
    }
    clickLog.push({ t: s - t0, name: tg.name, ms: Date.now() - s, ok, err });
  }
  await new Promise((r) => setTimeout(r, clicks ? 3000 : 1000));
}
const probe = await page.evaluate(() => ({ ...window.__probe, intervals: window.__probe.intervals() })).catch((e) => ({ evalError: String(e) }));
await browser.close();

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
const lt = probe.longtasks ?? [];
const durs = lt.map((x) => x[1]).sort((a, b) => a - b);
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
const tbt = lt.reduce((s, [, d]) => s + Math.max(0, d - 50), 0);
const ct = probe.commitTimes ?? [];
const span = (ct.at(-1) ?? 0) - (ct[0] ?? 0);
const lags = (probe.lags ?? []).map((x) => x[1]).sort((a, b) => a - b);
const ev = (probe.events ?? []).map((x) => x[2]).sort((a, b) => a - b);
const summary = {
  args: { base, secs, cpu, cockpit, fx, step: step ?? null, path },
  longTasks: lt.length, longestTaskMs: durs.at(-1) ?? 0, p95TaskMs: pct(durs, 0.95), tbtPerMinMs: Math.round(tbt / (secs / 60)),
  commits: probe.commits, commitsPerSec: span > 0 ? Math.round((ct.length / (span / 1000)) * 10) / 10 : null,
  maxHeartbeatLagMs: lags.at(-1) ?? 0, beatsLate: lags.length,
  eventP95Ms: pct(ev, 0.95), eventMaxMs: ev.at(-1) ?? 0, events: ev.length,
  clicks: clickLog.length, clicksFailed: clickLog.filter((c) => !c.ok).length, clickMaxMs: Math.max(0, ...clickLog.map((c) => c.ms)),
  pageErrors: probe.errors, consoleErrors: consoleErrors.slice(0, 10),
  heapFirstLastMB: [samples.find((s) => s.heapMB)?.heapMB ?? null, samples.at(-1)?.heapMB ?? null],
  nodesFirstLast: [samples.find((s) => s.nodes)?.nodes ?? null, samples.at(-1)?.nodes ?? null],
  intervals: probe.intervals,
  blockedWrites: blocked, apiRequests: requests, slowOrFailedApi: slow.slice(0, 20),
  sigChanges: samples.reduce((n, s, i) => n + (i && s.sig !== samples[i - 1].sig ? 1 : 0), 0),
};
const out = { summary, samples, clickLog, longtasks: lt, lags: probe.lags, commitTimes: ct };
if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify(summary, null, 1));
