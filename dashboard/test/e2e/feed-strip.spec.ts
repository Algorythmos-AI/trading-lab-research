import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The Options page's feed health strip (components/client/feed-strip.tsx) in each state the `feeds-*` fixture
// variants give it, on a phone and a desktop. The clock stands still on the server (`frozen`, 11:01 New York on the
// fixture's session) and in the browser; the live prices and the option feed are off, so the prices chip reads
// "Failed" (no keys) and the bars chip "Not due" (the board does not ask for them without prices).

const FROZEN_NOW = "2026-10-12T15:01:00Z";
const strip = (page: Page) => page.locator("[data-feed-strip]");
const chip = (page: Page, id: string) => page.locator(`[data-feed-chip="${id}"]`);

async function open(page: Page, context: BrowserContext, baseURL: string | undefined, variant: string, install = false) {
  await context.addCookies([{ name: "fx", value: `frozen.quotes-off.chain-off.${variant}`, url: baseURL! }]);
  if (install) await page.clock.install({ time: new Date(FROZEN_NOW) });
  else await page.clock.setFixedTime(new Date(FROZEN_NOW));
  await page.goto("/options");
  await expect(strip(page)).toBeVisible();
}

async function states(page: Page): Promise<Record<string, string | null>> {
  return Object.fromEntries(
    await page.locator("[data-feed-chip]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-feed-chip"), e.getAttribute("data-feed-state")])),
  );
}

const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`${sel} is not drawn`);
  return b;
};

test("all on time: six chips, one per feed, in order", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "feeds-ok");
  expect(await page.locator("[data-feed-chip]").evaluateAll((els) => els.map((e) => e.getAttribute("data-feed-chip")))).toEqual([
    "options-edition",
    "pre-open",
    "prices",
    "bars",
    "journal",
    "shadow",
  ]);
  // The prices chip waits for the page's first poll (no keys here: it answers "off").
  await expect(chip(page, "prices")).toHaveAttribute("data-feed-state", "failed");
  expect(await states(page)).toEqual({
    "options-edition": "on_time",
    "pre-open": "on_time",
    prices: "failed",
    bars: "not_expected",
    journal: "on_time",
    shadow: "on_time",
  });
  await expect(chip(page, "journal")).toContainText("On time");
  await expect(chip(page, "journal")).toContainText("5m");
  await expect(chip(page, "journal")).toHaveAttribute("aria-label", "Trade journal: On time, 5m old");
});

test("late: the edition for an earlier session, two missed journal runs, a silent server check", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "feeds-late");
  expect(await states(page)).toMatchObject({ "options-edition": "late", "pre-open": "on_time", journal: "late", shadow: "late" });
  await expect(chip(page, "options-edition")).toContainText("Late");
  await expect(chip(page, "options-edition")).toContainText("38h");
});

test("failed: a refused edition", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "feeds-failed");
  expect(await states(page)).toMatchObject({ "options-edition": "failed", journal: "on_time" });
  await expect(chip(page, "options-edition")).toContainText("Failed");
});

test("unknown: a store that cannot be read is never on time", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "feeds-unknown");
  expect(await states(page)).toMatchObject({ "options-edition": "unknown", "pre-open": "unknown", journal: "unknown" });
  await expect(chip(page, "journal")).toContainText("Can't check");
});

test("a late chip is in view without scrolling, and the strip never runs off the page", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "feeds-late");
  const viewport = page.viewportSize()!;
  for (const id of ["options-edition", "journal", "shadow"]) {
    const b = await box(page, `[data-feed-chip="${id}"]`);
    expect(b.y + b.height).toBeLessThanOrEqual(viewport.height);
    expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a chip changing state moves nothing: the strip and the board below it keep their place", async ({ page, context, baseURL }) => {
  // Between variants: the same layout whatever the states say.
  await open(page, context, baseURL, "feeds-ok");
  const okStrip = await box(page, "[data-feed-strip]");
  const okDesk = await box(page, '[aria-label="Options desk"]');
  await open(page, context, baseURL, "feeds-late");
  expect(await box(page, "[data-feed-strip]")).toEqual(okStrip);
  expect(await box(page, '[aria-label="Options desk"]')).toEqual(okDesk);
});

test("in place, as the clock moves on: the server check goes late and nothing below it moves", async ({ page, context, baseURL }) => {
  await open(page, context, baseURL, "feeds-ok", true);
  await expect(chip(page, "shadow")).toHaveAttribute("data-feed-state", "on_time");
  const before = { strip: await box(page, "[data-feed-strip]"), desk: await box(page, '[aria-label="Options desk"]') };
  // Its last record ended at 11:00 New York; ten minutes after it settled with nothing new, it is late.
  await page.clock.fastForward("15:00");
  await expect(chip(page, "shadow")).toHaveAttribute("data-feed-state", "late");
  expect(await box(page, "[data-feed-strip]")).toEqual(before.strip);
  expect(await box(page, '[aria-label="Options desk"]')).toEqual(before.desk);
});

test("an older edition has no strip", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "frozen.quotes-off.chain-off.feeds-late", url: baseURL! }]);
  await page.goto("/options?d=2026-10-12");
  await expect(page.locator('[aria-label="Options desk"]')).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
});

test("the Operations page's feeds are drawn from the same table: the ledger and the server check have their cards", async ({ page }) => {
  await page.goto("/operations");
  const panel = page.locator("#feeds");
  await expect(panel.getByRole("heading", { name: "Your feeds" })).toBeVisible();
  for (const name of ["Webull trades", "Options levels", "Top 4 focus card", "Pre-market radar", "Focus card ledger", "Server check", "Options live data", "Paper lab host"])
    await expect(panel.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(panel).toContainText("assumed 09:11 and 16:21 New York");
});

test("at 375 px the strip and the live prices' retry line are both drawn and never overlap", async ({ page, context, baseURL }) => {
  // `quotes-flaky` (see trade-now.spec.ts): the first quote answers, the next three fail, so the retry line is laid
  // over the board's header row for a few seconds while the strip stays at the top.
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script.quotes-flaky", url: baseURL! },
    { name: "fxstep", value: "3", url: baseURL! },
  ]);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/options");
  const retry = page.locator("[data-feed-retry]");
  await expect(retry).toBeVisible({ timeout: 10_000 });
  await expect(strip(page)).toBeVisible();
  const s = await box(page, "[data-feed-strip]");
  const r = await box(page, "[data-feed-retry]");
  const overlap = s.x < r.x + r.width && r.x < s.x + s.width && s.y < r.y + r.height && r.y < s.y + s.height;
  expect(overlap).toBe(false);
  // Never green beside "trying again".
  expect(await page.locator('[data-feed-chip="prices"]').getAttribute("data-feed-state")).not.toBe("on_time");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const offset of [-3_600_000, 3_600_000]) {
  test(`a device clock ${offset < 0 ? "an hour slow" : "an hour fast"} changes no chip: the strip runs on the server's time`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "fx", value: "frozen.quotes-off.chain-off.feeds-ok", url: baseURL! }]);
    await page.clock.install({ time: new Date(Date.parse(FROZEN_NOW) + offset) });
    await page.goto("/options");
    await expect(strip(page)).toBeVisible();
    // Long enough for the strip to have redrawn on the browser's side (it ticks every 15 s).
    await page.clock.runFor(31_000);
    await expect(chip(page, "prices")).toHaveAttribute("data-feed-state", "failed");
    expect(await states(page)).toEqual({
      "options-edition": "on_time",
      "pre-open": "on_time",
      prices: "failed",
      bars: "not_expected",
      journal: "on_time",
      shadow: "on_time",
    });
  });
}
