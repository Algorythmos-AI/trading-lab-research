import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The Options desk: one frame with the monitor of every name beside the selected name's map. The server
// runs in fixture mode; the `fx` cookie bends the fixtures into the states the desk must survive.
async function variant(context: BrowserContext, baseURL: string | undefined, fx: string) {
  await context.addCookies([{ name: "fx", value: fx, url: baseURL! }]);
}

const desk = (page: Page) => page.getByRole("region", { name: "Options desk" });

/**
 * Open the desk and wait until the browser has taken it over. The page arrives drawn by the server and becomes
 * interactive a moment later; a click or a key in between is lost, so a test that acted straight after `goto`
 * passed or failed on timing.
 */
async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(desk(page)).toHaveAttribute("data-ready", "true");
}
const rows = (page: Page) => page.locator("[data-desk-row]");
const row = (page: Page, symbol: string) => page.locator(`[data-desk-row="${symbol}"]`);
const order = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-desk-row")));

test("the desk shows every name beside the selected name's map and takes live prices", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "/options?view=live");
  await expect(desk(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  // The first name is selected until another is chosen, and its level map is drawn.
  await expect(page.locator('[data-desk-detail="SPY"]')).toBeVisible();
  await expect(page.getByRole("img", { name: /^SPY: last 40 daily bars/ })).toBeVisible();
  // The shared feed reaches the monitor: SPY is 0.3 ATR above its close, inside its major resistance zone.
  await expect(row(page, "SPY")).toContainText("TESTING RESISTANCE");
  // The chip is on screen, not clipped off the edge of a narrow monitor.
  await expect(row(page, "SPY").getByText("TESTING RESISTANCE")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("SPY-live-mark")).toBeAttached();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the whole desk fits one laptop screen", async ({ page, isMobile }) => {
  test.skip(isMobile, "one screen is the laptop layout; a phone scrolls");
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/options?view=brief");
  await expect(rows(page)).toHaveCount(10);
  const box = await desk(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  expect(box!.width).toBeGreaterThan(1300);
  // Centred in the window, with nothing hanging off either side.
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
});

/** How far the monitor's table is wider than the monitor itself: above zero means it scrolls sideways. */
const monitorOverflow = (page: Page) =>
  page.locator("[data-desk-monitor]").evaluate((el) => el.scrollWidth - el.clientWidth);

test("each view gives the monitor its own columns, and none of them needs sideways scrolling", async ({ page }) => {
  await open(page, "/options?view=brief");
  await expect(desk(page)).toHaveAttribute("data-desk-view", "brief");
  await expect(desk(page).getByRole("columnheader", { name: /^IV percentile/ })).toBeVisible();
  expect(await monitorOverflow(page)).toBeLessThanOrEqual(0);
  await desk(page).getByRole("button", { name: "Live", exact: true }).click();
  await expect(desk(page)).toHaveAttribute("data-desk-view", "live");
  await expect(desk(page).getByRole("columnheader", { name: /^State/ })).toBeVisible();
  // With live chips drawn, which is when the Live view is at its widest.
  await expect(row(page, "SPY")).toContainText("TESTING RESISTANCE");
  expect(await monitorOverflow(page)).toBeLessThanOrEqual(0);
  await desk(page).getByRole("button", { name: "Review", exact: true }).click();
  await expect(desk(page).getByRole("columnheader", { name: /^Paper trades/ })).toBeVisible();
  expect(await monitorOverflow(page)).toBeLessThanOrEqual(0);
  // AAPL took two paper trades in the fixture and won neither.
  await expect(row(page, "AAPL")).toContainText("\u22121.16R");
  await expect(page).toHaveURL(/view=review/);
});

test("choosing a name changes the map at once and a reload lands on the same name and view", async ({ page }) => {
  await open(page, "/options?view=brief");
  await row(page, "NVDA").click();
  await expect(page.locator('[data-desk-detail="NVDA"]')).toBeVisible();
  await expect(page.getByRole("img", { name: /^NVDA: last 40 daily bars/ })).toBeVisible();
  await expect(row(page, "NVDA").getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/s=NVDA/);
  await page.reload();
  await expect(page.locator('[data-desk-detail="NVDA"]')).toBeVisible();
  await expect(desk(page)).toHaveAttribute("data-desk-view", "brief");
});

test("the shortcuts still work after choosing a name with the mouse", async ({ page }) => {
  await open(page, "/options?view=brief&s=SPY");
  // Click a cell, not the name's button: focus must still end up inside the desk.
  await row(page, "QQQ").locator("td").first().click();
  await expect(page.locator('[data-desk-detail="QQQ"]')).toBeVisible();
  await expect(row(page, "QQQ").getByRole("button")).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator('[data-desk-detail="AAPL"]')).toBeVisible();
  // Changing view from a column header removes that header; the keyboard must keep working afterwards.
  await desk(page).getByRole("columnheader", { name: /^Close/ }).getByRole("button").focus();
  await page.keyboard.press("3");
  await expect(desk(page)).toHaveAttribute("data-desk-view", "review");
  await page.keyboard.press("k");
  await expect(page.locator('[data-desk-detail="QQQ"]')).toBeVisible();
});

test("the keyboard moves between names and views while focus is in the desk", async ({ page }) => {
  await open(page, "/options?view=brief&s=SPY");
  await row(page, "SPY").getByRole("button").focus();
  // Brief keeps the edition's order: SPY, QQQ, AAPL.
  await page.keyboard.press("j");
  await expect(page.locator('[data-desk-detail="QQQ"]')).toBeVisible();
  await expect(row(page, "QQQ").getByRole("button")).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator('[data-desk-detail="AAPL"]')).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.locator('[data-desk-detail="QQQ"]')).toBeVisible();
  await page.keyboard.press("3");
  await expect(desk(page)).toHaveAttribute("data-desk-view", "review");
  await page.keyboard.press("?");
  await expect(page.getByText("The single keys work while focus is inside the desk.", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("The single keys work while focus is inside the desk.", { exact: false })).toBeHidden();
});

test("the map reads a price under the pointer, and its layers switch off and on", async ({ page }) => {
  await open(page, "/options?view=brief&s=SPY");
  const map = page.getByRole("img", { name: /^SPY: last 40 daily bars/ });
  const readout = page.locator("[data-map-readout]");
  await expect(readout).toContainText("Point at the map");
  // Wait for the live state to arrive first. Its chip joins the heading above the map; on a narrow screen that
  // can push the map down a line, and a map that moves from under a resting pointer clears the crosshair.
  await expect(page.locator('[data-desk-detail="SPY"]')).toContainText("TESTING RESISTANCE");
  const box = await map.boundingBox();
  expect(box).not.toBeNull();
  // A third of the way in from the left and down from the top: inside the plot, on any screen.
  await map.hover({ position: { x: box!.width * 0.3, y: box!.height * 0.3 } });
  await expect(readout).toContainText("from the close");
  await expect(readout).toContainText("ATR");
  await expect(map.locator("[data-map-crosshair]")).toBeAttached();
  // Switching a layer off hides that layer and no other; switching it on brings it back.
  const layers = page.getByRole("group", { name: "Map layers" });
  const move = layers.getByRole("button", { name: "Expected move" });
  await expect(move).toHaveAttribute("aria-pressed", "true");
  await move.click();
  await expect(move).toHaveAttribute("aria-pressed", "false");
  await expect(map.locator('[data-layer="move"]')).toBeHidden();
  await expect(map.locator('[data-layer="zones"]')).toBeVisible();
  // The choice belongs to the desk, not to one name: it holds when another name is chosen.
  await row(page, "QQQ").getByRole("button").click();
  await expect(page.locator('[data-desk-detail="QQQ"]')).toBeVisible();
  await expect(page.getByRole("img", { name: /^QQQ: last 40 daily bars/ }).locator('[data-layer="move"]')).toBeHidden();
  await page.getByRole("group", { name: "Map layers" }).getByRole("button", { name: "Expected move" }).click();
  await expect(page.getByRole("img", { name: /^QQQ: last 40 daily bars/ }).locator('[data-layer="move"]')).toBeVisible();
});

const palette = (page: Page) => page.getByRole("dialog", { name: "Search names and actions" });

/** Open the palette with the keyboard and wait until its search box has the keyboard. */
async function openPalette(page: Page) {
  await page.keyboard.press("Control+k");
  await expect(palette(page).getByRole("combobox")).toBeFocused();
}

test("the command palette finds a name, a view and a layer, and hands the keyboard back to the desk", async ({ page }) => {
  await open(page, "/options?view=brief&s=SPY");
  await openPalette(page);
  await page.keyboard.type("nvda");
  await expect(palette(page).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('[data-desk-detail="NVDA"]')).toBeVisible();
  // Choosing an item also clears the search, and a fresh palette opens with its first row ready for Enter.
  await openPalette(page);
  await expect(palette(page).getByRole("combobox")).toHaveValue("");
  await expect(palette(page).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  await expect(page).toHaveURL(/s=NVDA/);
  // The desk has the keyboard again, on the chosen name: J moves on from NVDA to the next in the edition.
  await expect(row(page, "NVDA").getByRole("button")).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator('[data-desk-detail="AMZN"]')).toBeVisible();
  // A view by name. Other things match "review" loosely; the view ranks first and Enter takes the first.
  await openPalette(page);
  await page.keyboard.type("review");
  await expect(palette(page).getByRole("option").first()).toContainText("Review");
  await page.keyboard.press("Enter");
  await expect(desk(page)).toHaveAttribute("data-desk-view", "review");
  await expect(page).toHaveURL(/view=review/);
  // A map layer by what it does.
  await openPalette(page);
  await page.keyboard.type("hide expected");
  await expect(palette(page).getByRole("option").first()).toContainText("Hide expected move");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('[data-desk-detail="AMZN"] [data-layer="move"]')).toBeHidden();
});

test("the palette opens from its button, offers a way on when nothing matches, and closes on Escape", async ({ page }) => {
  await open(page, "/options?view=brief&s=SPY");
  await desk(page).getByRole("button", { name: /^Search/ }).click();
  await expect(palette(page).getByRole("combobox")).toBeFocused();
  await page.keyboard.type("zzzz");
  await expect(palette(page)).toContainText("Nothing matches");
  // The list is never left empty: one action is on offer, and Enter takes it.
  await expect(palette(page).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette(page).getByRole("combobox")).toHaveValue("");
  await expect(palette(page).getByRole("option", { name: /^SPY/ })).toBeVisible();
  // Escape changes nothing and gives the keyboard back to the selected name.
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('[data-desk-detail="SPY"]')).toBeVisible();
  await expect(row(page, "SPY").getByRole("button")).toBeFocused();
  // Each opening starts from an empty search.
  await openPalette(page);
  await expect(palette(page).getByRole("combobox")).toHaveValue("");
});

test("sorting a column keeps names without a value last, whichever way it runs", async ({ page, context, baseURL }) => {
  // In the sparse fixture SPY and AMZN have no expected move.
  await variant(context, baseURL, "partial.quotes-off");
  await open(page, "/options?view=brief");
  const head = desk(page).getByRole("columnheader", { name: /^1-day move/ });
  await head.getByRole("button").click();
  await expect(head).toHaveAttribute("aria-sort", "descending");
  let names = await order(page);
  expect(names[0]).toBe("META");
  expect([...names.slice(-2)].sort()).toEqual(["AMZN", "SPY"]);
  await head.getByRole("button").click();
  await expect(head).toHaveAttribute("aria-sort", "ascending");
  names = await order(page);
  expect(names[0]).toBe("NVDA");
  expect([...names.slice(-2)].sort()).toEqual(["AMZN", "SPY"]);
  // A third click puts the edition's own order back.
  await head.getByRole("button").click();
  expect((await order(page)).slice(0, 3)).toEqual(["SPY", "QQQ", "AAPL"]);
});

test("a sparse edition shows dashes on the desk, never NaN, and no pane breaks", async ({ page, context, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await variant(context, baseURL, "partial.quotes-off");
  await open(page, "/options?view=brief");
  await expect(rows(page)).toHaveCount(10);
  // NVDA has no last bar: its close is a dash, and it has nothing to draw a map against.
  await expect(row(page, "NVDA")).toContainText("—");
  await row(page, "NVDA").click();
  await expect(page.getByText("No level map for this name")).toBeVisible();
  // AAPL has no zones in this variant, but it still has bars, so its map is drawn.
  await row(page, "AAPL").click();
  await expect(page.locator('[data-desk-detail="AAPL"]')).toBeVisible();
  const text = (await desk(page).textContent()) ?? "";
  expect(text).not.toMatch(/NaN|undefined|Infinity/);
  await expect(page.locator("[data-pane-error]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a corrupt paper record breaks the scorecard and nothing else", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "poison");
  await open(page, "/options?view=review");
  await expect(rows(page)).toHaveCount(10);
  await expect(page.locator('[data-desk-detail="SPY"]')).toBeVisible();
  await expect(page.locator('[data-pane-error="Paper scorecard"]')).toBeVisible();
  await expect(page.locator("[data-pane-error]")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Entry rules" })).toBeVisible();
});

test("nothing published and storage down each say so in place of the desk", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "empty");
  await page.goto("/options");
  await expect(page.getByText("The options levels have not published yet")).toBeVisible();
  await expect(desk(page)).toHaveCount(0);
  await variant(context, baseURL, "error");
  await page.goto("/options");
  await expect(page.getByText("Storage could not be read")).toBeVisible();
});

test("live price updates change the monitor's numbers without moving the desk", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "quotes-tick");
  await open(page, "/options?view=live");
  // The feed is live once SPY carries a live state; the names that need a look have sorted to the top by then.
  await expect(row(page, "SPY")).toContainText("TESTING RESISTANCE");
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
    const spy = document.querySelector('[data-desk-row="SPY"]');
    const texts = new Set<string>();
    for (let i = 0; i < 14; i++) {
      texts.add(spy?.textContent ?? "");
      await new Promise((r) => setTimeout(r, 500));
    }
    observer.disconnect();
    return { shift, texts: texts.size };
  });
  expect(seen.texts, "the SPY row should have changed at least once").toBeGreaterThan(1);
  expect(seen.shift, "cumulative layout shift while prices update").toBe(0);
});
