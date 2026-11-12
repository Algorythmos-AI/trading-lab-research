import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { scan, useTheme } from "./axe";

// CI-only. The Feeds page (/options/feeds, DEC-0050) in fixture mode: the board's live feed (IEX here, as ALPACA_FEED
// is unset), today's made-up stamps, the live rows for the focus names (SPY and QQQ with `focus`) and, after the close
// (the page's own `fxfeeds=after-close`, feeds-live.ts), the two synthetic compared sessions. During the session (`frozen`, 11:01 New York) the
// comparison is not drawn.

const FROZEN_NOW = "2026-10-12T15:01:00Z";
const AFTER_CLOSE = "2026-10-12T20:30:00Z";

async function open(page: Page, context: BrowserContext, baseURL: string | undefined, flags: string, at = FROZEN_NOW, feeds = "") {
  await context.addCookies([
    { name: "fx", value: flags, url: baseURL! },
    { name: "fxfeeds", value: feeds, url: baseURL! },
  ]);
  await page.clock.setFixedTime(new Date(at));
  await page.goto("/options/feeds");
  await expect(page.getByRole("heading", { level: 1, name: "Feeds" })).toBeVisible();
  await expect(page.locator("[data-feeds-row]").first()).toBeVisible();
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("in a session: the board's feed named, the stamps counted, the live rows drawn, no comparison", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus");
  await expect(page.locator("[data-board-feed]")).toHaveAttribute("data-board-feed", "iex");
  await expect(page.locator("[data-board-feed]")).toContainText("IEX — the board is not on SIP yet (DEC-0050)");
  await expect(page.locator("[data-stamp-panel]")).toHaveAttribute("data-stamp-panel", "session");
  await expect(page.locator("[data-stamp-panel]")).toContainText("over 91 minutes since the open");
  await expect(page.locator("[data-feeds-row]")).toHaveCount(2);
  for (const row of await page.locator("[data-feeds-row]").all()) {
    await expect(row).toHaveAttribute("data-stale", "false");
    await expect(row).toContainText("IEX price");
    await expect(row.locator("svg[role=img]")).toBeVisible();
  }
  await expect(page.locator("[data-compared]")).toHaveCount(0);
  await expect(page.getByText("Shown after the close")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("after the close: the compared sessions, newest first, counts only", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "focus", AFTER_CLOSE, "after-close");
  await expect(page.locator("[data-stamp-panel]")).toHaveAttribute("data-stamp-panel", "closed");
  const days = await page.locator("[data-compared-day]").evaluateAll((els) => els.map((e) => e.getAttribute("data-compared-day")));
  expect(days).toEqual(["2026-10-09", "2026-10-08"]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("at 414 px nothing scrolls sideways, in the session and after the close", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 414, height: 896 });
  await open(page, context, baseURL, "frozen.focus");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await context.clearCookies();
  await open(page, context, baseURL, "focus", AFTER_CLOSE, "after-close");
  await expect(page.locator("[data-compared]")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("a name with no new trade past the board's limit greys out and says for how long", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "frozen.focus", FROZEN_NOW, "row-stale");
  const rows = page.locator("[data-feeds-row]");
  await expect(rows.last()).toHaveAttribute("data-stale", "true");
  await expect(rows.last().locator("[data-stale-line]")).toHaveText(/^No new price for \d+ s$/);
  await expect(rows.first()).toHaveAttribute("data-stale", "false");
});

test("the Options page's Feeds link reaches the page", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen.quotes-off.chain-off.focus", url: baseURL! }]);
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  await page.goto("/options");
  const link = page.locator("[data-feeds-link] a");
  await expect(link).toHaveAttribute("href", "/options/feeds");
  await link.click();
  await expect(page).toHaveURL(/\/options\/feeds$/);
  await expect(page.getByRole("heading", { level: 1, name: "Feeds" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  for (const [when, flags, at, feeds] of [
    ["in a session", "frozen.focus", FROZEN_NOW, "row-stale"],
    ["after the close", "focus", AFTER_CLOSE, "after-close"],
  ] as const) {
    test(`the Feeds page passes the accessibility scan ${when} in ${theme}`, async ({ page, context, baseURL }) => {
      await useTheme(context, theme);
      await open(page, context, baseURL, flags, at, feeds);
      expect(await scan(page)).toEqual([]);
    });
  }
}
