import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { scan, useTheme } from "./axe";

// CI-only. The market bar at the top of the Options page (B2): SPY and QQQ from /api/flow. The fixture's flow answer
// stands at FROZEN_NOW (11:01 New York); the browser's clock is stood there too, or the answer reads as old. The live
// prices and the chain are off, so nothing else on the page moves while the bar is looked at.

const FROZEN_NOW = "2026-10-12T15:01:00Z";

async function open(page: Page, context: BrowserContext, baseURL: string | undefined, flags = "", frozenClock = true) {
  await context.addCookies([{ name: "fx", value: ["frozen", "quotes-off", "chain-off", flags].filter(Boolean).join("."), url: baseURL! }]);
  if (frozenClock) await page.clock.setFixedTime(new Date(FROZEN_NOW));
  await page.goto("/options");
}

const bar = (page: Page) => page.locator("section[data-market-bar]");
const tile = (page: Page, s: string) => bar(page).locator(`[data-index-tile="${s}"]`);
const settled = (page: Page) => expect(bar(page)).not.toHaveAttribute("data-market-read", "loading");

test("the default fixture reads MARKET UP, with both tiles' evidence and the Testing mark", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL);
  await expect(bar(page)).toHaveAttribute("data-market-read", "up");
  await expect(bar(page).getByRole("heading", { name: "Market: SPY and QQQ" })).toBeAttached();
  await expect(bar(page).locator("[data-market-head]")).toHaveText("▲MARKET UP");
  for (const s of ["SPY", "QQQ"]) {
    await expect(tile(page, s)).toHaveAttribute("data-direction", "up");
    await expect(tile(page, s).locator("[data-index-direction]")).toHaveText("▲ UP");
    await expect(tile(page, s).locator("[data-index-vwap]")).toContainText(/above VWAP \d+\.\d\d/);
    await expect(tile(page, s).locator("[data-index-volume]")).toHaveText(/^\d\.\d× normal volume$/);
    await expect(tile(page, s).locator("[data-index-spread]")).toHaveText(/^\d\.\d bp spread$/);
  }
  await expect(bar(page).locator("[data-market-footer]")).toHaveText("SIP · as of 11:01:00 New York · checked just now · Testing");
  // the bar sits above everything else the live page draws
  const top = await bar(page).boundingBox();
  const rail = await page.locator("[data-status-rail]").first().boundingBox();
  expect(top!.y).toBeLessThan(rail!.y);
});

for (const [flag, read, word] of [
  ["flow-down", "down", "▼MARKET DOWN"],
  ["flow-mixed", "mixed", "◆MIXED"],
  ["flow-range", "range", "▬RANGE"],
] as const) {
  test(`${flag} reads ${read}`, async ({ page, context, baseURL }) => {
    await open(page, context, baseURL, flag);
    await expect(bar(page)).toHaveAttribute("data-market-read", read);
    await expect(bar(page).locator("[data-market-head]")).toHaveText(word);
    if (read === "mixed") await expect(bar(page).locator("[data-market-line]")).toHaveText("SPY up · QQQ down");
  });
}

for (const [flag, line] of [
  ["flow-off", "live data is off"],
  ["flow-error", "prices could not be read"],
] as const) {
  test(`${flag} gives the calm not-available state, with no colour and no numbers`, async ({ page, context, baseURL }) => {
    await open(page, context, baseURL, flag);
    await expect(bar(page)).toHaveAttribute("data-market-read", "none");
    await expect(bar(page).locator("[data-market-head]")).toHaveText("NOT AVAILABLE");
    await expect(bar(page).locator("[data-market-line]")).toHaveText(line);
    await expect(bar(page).locator('[data-direction="none"]')).toHaveCount(2);
    await expect(bar(page).locator("[data-index-price]").first()).toHaveText("–");
    await expect(page.locator("[data-pane-error]")).toHaveCount(0);
  });
}

test("flow-crossed shows crossed in the tile and gives no market read", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "flow-crossed");
  await expect(bar(page)).toHaveAttribute("data-market-read", "none");
  await expect(bar(page).locator("[data-market-line]")).toHaveText("QQQ: quote is crossed");
  await expect(tile(page, "QQQ").locator("[data-index-spread]")).toHaveText("crossed");
  await expect(tile(page, "QQQ")).toHaveAttribute("data-direction", "none");
});

test("a device clock an hour ahead of the answer is not available and says why, never a colour", async ({ page, context, baseURL }) => {
  // The answer stands at FROZEN_NOW; the browser's clock stands an hour later.
  await context.addCookies([{ name: "fx", value: "frozen.quotes-off.chain-off", url: baseURL! }]);
  await page.clock.setFixedTime(new Date(Date.parse(FROZEN_NOW) + 3_600_000));
  await page.goto("/options");
  await expect(bar(page)).toHaveAttribute("data-market-read", "none");
  await expect(bar(page).locator("[data-market-line]")).toHaveText("this device's clock is off");
  await expect(bar(page).locator('[data-direction="none"]')).toHaveCount(2);
});

for (const [flags, url] of [
  ["empty", "/options"],
  ["error", "/options"],
  ["", "/options?view=classic"],
] as const) {
  test(`the bar also stands ${flags ? `with the edition ${flags === "empty" ? "missing" : "unreadable"}` : "in the classic view"}`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "fx", value: ["frozen.quotes-off.chain-off", flags].filter(Boolean).join("."), url: baseURL! }]);
    await page.clock.setFixedTime(new Date(FROZEN_NOW));
    await page.goto(url);
    await expect(bar(page)).toHaveAttribute("data-market-read", "up");
  });
}

test("the bar keeps its height from first paint to the answer, and a phone does not scroll sideways", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen.quotes-off.chain-off", url: baseURL! }]);
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  // Hold the first answer back, so the server-drawn (loading) bar can be measured before it.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/flow**", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/options");
  await expect(bar(page)).toHaveAttribute("data-market-read", "loading");
  const before = (await bar(page).boundingBox())!.height;
  release();
  await expect(bar(page)).toHaveAttribute("data-market-read", "up");
  expect((await bar(page).boundingBox())!.height).toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("the served page carries no streamed skeleton for the bar", async ({ request }) => {
  const html = await (await request.get("/options", { headers: { cookie: "fx=frozen.quotes-off.chain-off" } })).text();
  expect(html).toContain("data-market-bar");
  // The only streamed parts are the two route-level loading boundaries (app/loading.tsx, app/options/loading.tsx),
  // as before the bar: it has no Suspense of its own and is sent in the page's one piece.
  expect(html.match(/<template/g) ?? []).toHaveLength(2);
});

for (const theme of ["light", "dark"] as const) {
  for (const flag of ["", "flow-down", "flow-mixed", "flow-range", "flow-crossed", "flow-off"]) {
    test(`the bar passes the accessibility scan in ${theme}${flag ? ` with ${flag}` : ""}`, async ({ page, context, baseURL }) => {
      await useTheme(context, theme);
      await open(page, context, baseURL, flag);
      await settled(page);
      expect(await scan(page)).toEqual([]);
    });
  }
}
