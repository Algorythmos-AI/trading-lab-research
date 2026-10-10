import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The server runs in fixture mode, and the `fx` cookie bends the fixtures into the states a pane must
// survive (src/lib/fixture-variants.ts): nothing published, storage down, a sparse edition, a corrupt one, and the
// live feed off, failing or ticking.
async function variant(context: BrowserContext, baseURL: string | undefined, fx: string) {
  await context.addCookies([{ name: "fx", value: fx, url: baseURL! }]);
}

const glanceRows = (page: Page) => page.getByRole("list", { name: "Every name against its nearest zones" }).getByRole("listitem");

test("nothing published yet says what will fill the page", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "empty");
  await page.goto("/options");
  await expect(page.getByText("The options levels have not published yet")).toBeVisible();
});

test("storage that cannot be read says so", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "error");
  await page.goto("/options");
  await expect(page.getByText("Storage could not be read")).toBeVisible();
});

test("a sparse edition shows dashes, never NaN, and breaks no pane", async ({ page, context, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await variant(context, baseURL, "partial");
  await page.goto("/options");
  await expect(glanceRows(page)).toHaveCount(10);
  // QQQ has no ATR in this variant, so its bar cannot be drawn and the row says why.
  await expect(glanceRows(page).filter({ hasText: "QQQ" })).toContainText("No ATR in this edition");
  // NVDA has no last bar: its close is a dash, not a zero.
  await expect(glanceRows(page).filter({ hasText: "NVDA" })).toContainText("—");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).not.toMatch(/NaN|undefined|Infinity/);
  await expect(page.locator("[data-pane-error]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Paper scorecard" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("a corrupt edition fails one pane and leaves every other pane working", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "poison");
  await page.goto("/options");
  const broken = page.locator('[data-pane-error="Paper scorecard"]');
  await expect(broken).toBeVisible();
  await expect(broken).toContainText("The rest of the page is unaffected");
  await expect(page.locator("[data-pane-error]")).toHaveCount(1);
  // Everything else is still there: the strip, the rules, the level maps, the findings.
  await expect(glanceRows(page)).toHaveCount(10);
  await expect(page.getByRole("heading", { name: "Entry rules" })).toBeVisible();
  await expect(page.getByRole("img", { name: /^SPY: last 40 daily bars/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What the testing found" })).toBeVisible();
  await expect(page.getByText("This page could not be drawn")).toHaveCount(0);
  // Retrying a pane that is still broken shows the same notice again, not a crash.
  await broken.getByRole("button", { name: "Try again" }).click();
  await expect(broken).toBeVisible();
  await expect(glanceRows(page)).toHaveCount(10);
});

test("a live feed with no keys reads as off and the strip stays on the close", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "quotes-off");
  await page.goto("/options");
  await expect(page.getByText("Live off")).toBeVisible();
  await expect(page.getByText("Live prices are off", { exact: false })).toBeVisible();
  await expect(glanceRows(page)).toHaveCount(10);
});

test("a failing live feed reads as retrying and the strip stays on the close", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "quotes-error");
  await page.goto("/options");
  await expect(page.getByText("Retrying")).toBeVisible();
  await expect(page.getByText("Live prices did not answer", { exact: false })).toBeVisible();
  await expect(glanceRows(page)).toHaveCount(10);
});

test("live price updates change the numbers without moving the page", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "quotes-tick");
  await page.goto("/options");
  const spy = glanceRows(page).filter({ hasText: "SPY" });
  // The feed is live once SPY carries a live state.
  await expect(spy).toContainText("TESTING RESISTANCE");
  // Watch for seven seconds: three or four polls, across which the fixture price flips by a cent at least once.
  const seen = await page.evaluate(async () => {
    let shift = 0;
    const observer = new PerformanceObserver((list) => {
      type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
      for (const entry of list.getEntries() as Shift[]) {
        // Only what moves inside the page body counts: the header's clocks tick on their own.
        const inMain = (entry.sources ?? []).some((src) => src.node && document.querySelector("main")?.contains(src.node));
        if (!entry.hadRecentInput && (inMain || (entry.sources ?? []).length === 0)) shift += entry.value;
      }
    });
    observer.observe({ type: "layout-shift" });
    const row = [...document.querySelectorAll('[role="listitem"]')].find((r) => r.textContent?.startsWith("SPY"));
    const texts = new Set<string>();
    for (let i = 0; i < 14; i++) {
      texts.add(row?.textContent ?? "");
      await new Promise((r) => setTimeout(r, 500));
    }
    observer.disconnect();
    return { shift, texts: texts.size };
  });
  expect(seen.texts, "the SPY row should have changed at least once").toBeGreaterThan(1);
  expect(seen.shift, "cumulative layout shift while prices update").toBe(0);
});
