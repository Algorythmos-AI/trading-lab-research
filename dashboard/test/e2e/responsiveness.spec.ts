import { expect, test, type BrowserContext } from "@playwright/test";

// The Options page's main-thread budget, on the scripted morning's live step with the cockpit on (as on 2026-11-20,
// when the page froze). Before the fix it ran seven 1 s clocks and two 250 ms ones, each at its own phase, and drew
// about fifteen times a second. These count what is due to the page's own timers, so they hold on any machine:
//   - one 1 s timer for the whole page, and no 250 ms one while nothing counts down;
//   - React commits a few times a second at most, not once per clock.

const INIT = `
(() => {
  const live = new Map();
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (fn, ms, ...rest) { const id = si.call(window, fn, ms, ...rest); live.set(id, ms); return id; };
  window.clearInterval = function (id) { live.delete(id); return ci.call(window, id); };
  window.__intervals = () => [...live.values()];
  let commits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(r) { const i = this.renderers.size + 1; this.renderers.set(i, r); return i; },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
    onCommitFiberRoot() { commits++; },
  };
  window.__commits = () => commits;
  try { localStorage.setItem("options-cockpit", "on"); } catch {}
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: () => Promise.resolve({ release: () => Promise.resolve(), addEventListener: () => undefined }) } });
})();
`;

async function live(context: BrowserContext, baseURL: string | undefined) {
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script", url: baseURL! },
    { name: "fxstep", value: "3", url: baseURL! },
  ]);
  await context.addInitScript(INIT);
}

test("the live Options page runs one 1 s clock and no 250 ms one", async ({ page, context, baseURL, isMobile }) => {
  test.skip(isMobile, "the desktop cockpit");
  await live(context, baseURL);
  await page.goto("/options");
  await expect(page.locator("[data-cockpit-switch]").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-trade-now] [data-board-row]").first()).toHaveAttribute("data-board-state", "enter_zone");
  await page.waitForTimeout(3_000);
  const intervals = await page.evaluate(() => (window as unknown as { __intervals: () => number[] }).__intervals());
  expect(intervals.filter((ms) => ms === 1_000), `live intervals: ${intervals.join(", ")}`).toHaveLength(1);
  expect(intervals.filter((ms) => ms === 250)).toHaveLength(0);
});

test("the live Options page draws a few times a second, not once per clock", async ({ page, context, baseURL, isMobile }) => {
  test.skip(isMobile, "the desktop cockpit");
  await live(context, baseURL);
  await page.goto("/options");
  await expect(page.locator("[data-cockpit-switch]").first()).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(5_000); // load, hydration, the first answers
  const count = () => page.evaluate(() => (window as unknown as { __commits: () => number }).__commits());
  const from = await count();
  await page.waitForTimeout(10_000);
  const perSecond = ((await count()) - from) / 10;
  // 2 to 3 with the shared clock (the 1 s tick, the 2 s quotes and their follow-ups); about 15 before it.
  expect(perSecond).toBeLessThan(6);
});

test("the main thread stays free and a click answers at once while the board is live", async ({ page, context, baseURL, isMobile }) => {
  test.skip(isMobile, "the desktop cockpit");
  await live(context, baseURL);
  await page.goto("/options");
  const toggle = page.locator("[data-cockpit-switch]").first();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(3_000);
  // A 50 ms heartbeat for 5 s: how late its worst beat ran is the longest the page could not answer a click.
  const worstLate = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        let last = performance.now();
        let worst = 0;
        const end = last + 5_000;
        const beat = () => {
          const n = performance.now();
          worst = Math.max(worst, n - last - 50);
          last = n;
          if (n < end) setTimeout(beat, 50);
          else done(worst);
        };
        setTimeout(beat, 50);
      }),
  );
  expect(worstLate).toBeLessThan(1_000);
  const started = Date.now();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(Date.now() - started).toBeLessThan(2_000);
});
