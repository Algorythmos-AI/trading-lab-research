import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The Options desk: one frame with the monitor of every name beside the selected name's map. The server
// runs in fixture mode; the `fx` cookie bends the fixtures into the states the desk must survive.
//
// Every test runs twice, at a laptop's width and at a phone's. A phone shows the list or the selected name, one at
// a time, so a test that needs the other pane asks for it with `showPane`, which does nothing on a wide screen.
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
const paneTab = (page: Page, name: string) => desk(page).getByRole("group", { name: "Pane" }).getByRole("button", { name, exact: true });
/**
 * On a phone, bring the list ("Names") or the selected name (its ticker) to the front. A wide screen shows both and
 * has no bar to switch them. Whether this is a phone is read off the bar, not the button: a wrong ticker then fails
 * here, on the click, instead of passing silently.
 */
async function showPane(page: Page, name: string) {
  if (await page.locator("[data-desk-bar]").isVisible()) await paneTab(page, name).click();
}
/** Choose a name from the list, bringing the list back first where a phone has an open name in front of it. */
async function pick(page: Page, symbol: string) {
  await showPane(page, "Names");
  await row(page, symbol).getByRole("button").click();
}
/** A name's own page has no desk to wait on: wait for its pane to be taken over by the browser. */
async function openName(page: Page, symbol: string) {
  await page.goto(`/options/${symbol}`);
  await expect(page.locator(`[data-name-page="${symbol.toUpperCase()}"]`)).toHaveAttribute("data-ready", "true");
}
const detail = (page: Page, symbol: string) => page.locator(`[data-desk-detail="${symbol}"]`);
const rows = (page: Page) => page.locator("[data-desk-row]");
const row = (page: Page, symbol: string) => page.locator(`[data-desk-row="${symbol}"]`);
const order = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-desk-row")));

test("the desk shows every name and the selected name's map, and takes live prices", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "/options?view=live");
  await expect(desk(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  // The shared feed reaches the monitor: SPY is 0.3 ATR above its close, inside its major resistance zone.
  await expect(row(page, "SPY")).toContainText("TESTING RESISTANCE");
  // The chip is on screen, not clipped off the edge of a narrow monitor.
  await expect(row(page, "SPY").getByText("TESTING RESISTANCE")).toBeInViewport({ ratio: 1 });
  // The first name is selected until another is chosen, and its level map is drawn.
  await showPane(page, "SPY");
  await expect(detail(page, "SPY")).toBeVisible();
  await expect(page.getByRole("img", { name: /^SPY: last 40 daily bars/ })).toBeVisible();
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
  // Found by tag, not by role: on a phone the list is behind the open name, and a role lookup skips what is hidden.
  await expect(row(page, "NVDA").locator("button")).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/s=NVDA/);
  await page.reload();
  await expect(page.locator('[data-desk-detail="NVDA"]')).toBeVisible();
  await expect(desk(page)).toHaveAttribute("data-desk-view", "brief");
});

test("the shortcuts still work after choosing a name with the mouse", async ({ page, isMobile }) => {
  test.skip(isMobile, "on a phone choosing a name opens it in place of the list; the phone test below covers that");
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

test("the keyboard moves between names and views while focus is in the desk", async ({ page, isMobile }) => {
  test.skip(isMobile, "the list and the name share the screen only on a wide one; the phone test below covers stepping");
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
  await showPane(page, "SPY");
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
  await pick(page, "QQQ");
  await expect(page.locator('[data-desk-detail="QQQ"]')).toBeVisible();
  await expect(page.getByRole("img", { name: /^QQQ: last 40 daily bars/ }).locator('[data-layer="move"]')).toBeHidden();
  await page.getByRole("group", { name: "Map layers" }).getByRole("button", { name: "Expected move" }).click();
  await expect(page.getByRole("img", { name: /^QQQ: last 40 daily bars/ }).locator('[data-layer="move"]')).toBeVisible();
});

test("on a phone the desk shows one pane at a time, and the bar at the bottom switches panes and steps through names", async ({ page, isMobile }) => {
  test.skip(!isMobile, "a wide screen shows the list and the name side by side");
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const monitor = page.locator("[data-desk-monitor]");
  const bar = page.locator("[data-desk-bar]");
  await open(page, "/options?view=brief");
  // The list alone at first, with the bar in reach at the bottom of the screen.
  await expect(monitor).toBeVisible();
  await expect(detail(page, "SPY")).toBeHidden();
  await expect(bar).toBeInViewport({ ratio: 1 });
  await expect(paneTab(page, "Names")).toHaveAttribute("aria-pressed", "true");
  expect(await sideways()).toBeLessThanOrEqual(0);
  // A name opens in place of the list. The keyboard, and with it a screen reader's place, goes to its heading.
  await row(page, "QQQ").click();
  await expect(detail(page, "QQQ")).toBeVisible();
  await expect(monitor).toBeHidden();
  await expect(detail(page, "QQQ").getByRole("heading", { name: "QQQ" })).toBeFocused();
  await expect(paneTab(page, "QQQ")).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/pane=name/);
  // The name is taller than the screen, so the bar is held at the bottom of it.
  await expect(bar).toBeInViewport({ ratio: 1 });
  expect(await sideways()).toBeLessThanOrEqual(0);
  // The two arrows step through the names in the list's order (Brief keeps the edition's: SPY, QQQ, AAPL)
  // without leaving the name, and keep the focus so they can be pressed again.
  await bar.getByRole("button", { name: "Next name" }).click();
  await expect(detail(page, "AAPL")).toBeVisible();
  await bar.getByRole("button", { name: "Previous name" }).click();
  await expect(detail(page, "QQQ")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Previous name" })).toBeFocused();
  await bar.getByRole("button", { name: "Previous name" }).click();
  await expect(detail(page, "SPY")).toBeVisible();
  await expect(page).toHaveURL(/s=SPY/);
  // Half way down the name, its quote line is still at the top of the screen.
  await detail(page, "SPY").evaluate((el) => {
    const box = el.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + box.top + box.height / 2);
  });
  await expect(detail(page, "SPY").getByRole("heading", { name: "SPY" })).toBeInViewport({ ratio: 1 });
  // A reload lands on the same name, still open.
  await page.reload();
  await expect(desk(page)).toHaveAttribute("data-ready", "true");
  await expect(detail(page, "SPY")).toBeVisible();
  await expect(monitor).toBeHidden();
  // Back to the list: the name is still the selected one there, and the address forgets the pane.
  await paneTab(page, "Names").click();
  await expect(monitor).toBeVisible();
  await expect(detail(page, "SPY")).toBeHidden();
  await expect(row(page, "SPY").getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(page).not.toHaveURL(/pane=/);
  // The bar's other button opens the selected name again. Choosing a view from there brings the list back: a view
  // is the list's columns, so with the name in front it would change nothing on screen.
  await paneTab(page, "SPY").click();
  await expect(detail(page, "SPY")).toBeVisible();
  await desk(page).getByRole("button", { name: "Review", exact: true }).click();
  await expect(desk(page)).toHaveAttribute("data-desk-view", "review");
  await expect(monitor).toBeVisible();
  await expect(desk(page).getByRole("columnheader", { name: /^Paper trades/ })).toBeVisible();
  await expect(page).not.toHaveURL(/pane=/);
});

const palette = (page: Page) => page.getByRole("dialog", { name: "Search names and actions" });

/** Open the palette with the keyboard and wait until its search box has the keyboard. */
async function openPalette(page: Page) {
  await page.keyboard.press("Control+k");
  await expect(palette(page).getByRole("combobox")).toBeFocused();
}

test("the command palette finds a name, a view and a layer, and hands the keyboard back to the desk", async ({ page, isMobile }) => {
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
  // The desk has the keyboard again, on the chosen name: J moves on from NVDA to the next in the edition. On a
  // phone the palette opened the name in place of the list, so there the keyboard is on the name's heading.
  await expect(isMobile ? detail(page, "NVDA").getByRole("heading", { name: "NVDA" }) : row(page, "NVDA").getByRole("button")).toBeFocused();
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
  await expect(row(page, "SPY").getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "SPY").getByRole("button")).toBeFocused();
  // Each opening starts from an empty search.
  await openPalette(page);
  await expect(palette(page).getByRole("combobox")).toHaveValue("");
});

// Exact: the scenario table inside it is a region too, named "SPY contract scenarios".
const contract = (page: Page) => page.getByRole("region", { name: "SPY contract", exact: true });

test("the contract pane prices the call or put the reader names, remembers it across a reload, and forgets it when cleared", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "/options?view=live&s=SPY");
  await showPane(page, "SPY");
  // Shut until asked for: no option quotes are fetched for a name nobody is pricing.
  await expect(contract(page)).toHaveAttribute("data-contract", "closed");
  // Nothing priced, nothing drawn: the map shows a breakeven only for the contract in the pane.
  const breakeven = detail(page, "SPY").locator("[data-breakeven]");
  await expect(breakeven).toHaveCount(0);
  await contract(page).getByRole("button", { name: "Price a call or put" }).click();
  await expect(contract(page)).toHaveAttribute("data-contract", "ready");
  // The map now marks where this contract breaks even: on the map, or named at the edge it lies beyond.
  await expect(breakeven).toHaveCount(1);
  await expect(breakeven).toHaveAttribute("data-breakeven", /^(on|above|below)$/);
  await expect(breakeven.locator("text")).toContainText(/Breakeven \d/);
  // It opens on a call at the nearest expiry, priced at the ask, with a row for where the stock is now.
  await expect(contract(page).getByRole("button", { name: "Call", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(contract(page)).toContainText("at the ask");
  await expect(contract(page).getByRole("columnheader", { name: "Expiry" })).toBeVisible();
  await expect(contract(page).getByRole("rowheader", { name: /(Now|Last close)$/ })).toBeVisible();
  // Under the scenarios: the expiry's volatility strike by strike, as a picture and as the same numbers in a table.
  const shape = contract(page).locator("[data-vol-shape]");
  await expect(shape.getByRole("img", { name: /Implied volatility at each level/ })).toBeVisible();
  expect(Number(await shape.getAttribute("data-vol-shape"))).toBeGreaterThanOrEqual(3);
  await shape.getByText(/The same as a table/).click();
  await expect(shape.getByRole("columnheader", { name: "Strike" })).toBeVisible();
  await expect(shape.getByRole("row")).not.toHaveCount(1);
  // Three puts bought at 2.00 on the last expiry offered, more than a fortnight out: $600 at risk, and with a
  // price paid there is a profit or loss now.
  await contract(page).getByRole("button", { name: "Put", exact: true }).click();
  const expiry = contract(page).getByLabel("Expiry");
  await expiry.selectOption({ index: (await expiry.locator("option").count()) - 1 });
  await contract(page).getByLabel("Contracts").fill("3");
  await contract(page).getByLabel("Paid, per share").fill("2");
  await expect(contract(page)).toContainText("$600");
  await expect(contract(page)).not.toContainText("at the ask");
  expect((await contract(page).textContent()) ?? "").not.toMatch(/NaN|undefined|Infinity/);
  // A reload opens the pane on the same contract.
  await page.reload();
  await expect(desk(page)).toHaveAttribute("data-ready", "true");
  await showPane(page, "SPY");
  await expect(contract(page)).toHaveAttribute("data-contract", "ready");
  await expect(contract(page).getByRole("button", { name: "Put", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(contract(page).getByLabel("Contracts")).toHaveValue("3");
  await expect(contract(page).getByLabel("Paid, per share")).toHaveValue("2");
  await expect(contract(page)).toContainText("$600");
  // Cleared, it is shut again and stays shut.
  await contract(page).getByRole("button", { name: "Clear" }).click();
  await expect(contract(page)).toHaveAttribute("data-contract", "closed");
  await page.reload();
  await expect(desk(page)).toHaveAttribute("data-ready", "true");
  await expect(contract(page)).toHaveAttribute("data-contract", "closed");
  expect(errors).toEqual([]);
});

test("the contract pane says so when option quotes are off, failing or damaged, and the rest of the name stands", async ({ page, context, baseURL }) => {
  const openPane = async (fx: string) => {
    await variant(context, baseURL, fx);
    await open(page, "/options?view=live&s=SPY");
    await showPane(page, "SPY");
    await contract(page).getByRole("button", { name: "Price a call or put" }).click();
  };
  await openPane("chain-off");
  await expect(contract(page)).toHaveAttribute("data-contract", "off");
  await expect(contract(page)).toContainText("Option quotes are not set up on this site");
  await openPane("chain-error");
  await expect(contract(page)).toHaveAttribute("data-contract", "error");
  await expect(contract(page).getByRole("button", { name: "Try again" })).toBeVisible();
  // The map and the facts of the name are untouched by either.
  await expect(page.getByRole("img", { name: /^SPY: last 40 daily bars/ })).toBeVisible();
  await expect(page.locator("[data-pane-error]")).toHaveCount(0);
  // Damaged quotes: the three lowest calls come with no volatility, no market, and a crossed quote.
  await openPane("chain-thin");
  await expect(contract(page)).toHaveAttribute("data-contract", "ready");
  const strike = contract(page).getByLabel("Strike");
  await strike.selectOption({ index: 0 });
  await expect(contract(page)).toContainText("name");
  await strike.selectOption({ index: 1 });
  await expect(contract(page)).toContainText("no market");
  await expect(contract(page)).toContainText("at the model's value");
  await strike.selectOption({ index: 2 });
  await expect(contract(page)).toContainText("crossed quote");
  expect((await contract(page).textContent()) ?? "").not.toMatch(/NaN|undefined|Infinity/);
  await expect(page.locator("[data-pane-error]")).toHaveCount(0);
});

const positions = (page: Page) => page.getByRole("region", { name: "Paper option positions" });

test("the paper positions sit under the list, and opening one prices the contract that is held", async ({ page }) => {
  await open(page, "/options?view=live");
  await expect(positions(page)).toBeVisible();
  await expect(positions(page)).toHaveAttribute("data-positions", "fresh");
  await expect(positions(page).getByRole("listitem")).toHaveCount(3);
  // Two contracts of the SPY call, paid 2.85 and marked 3.10: fifty dollars up. The three together: 12.50 up.
  await expect(positions(page).getByRole("listitem").filter({ hasText: "SPY" })).toContainText("+$50");
  await expect(positions(page)).toContainText(/open result \+\$13/);
  // A position on one of the desk's names is priced from the option feed: its delta and what a day costs.
  await expect(positions(page).getByRole("listitem").filter({ hasText: "SPY" }).locator("[data-greeks]")).toContainText(/Δ −?\d\.\d\d · [−+]\$[\d,]+(\/day| to expiry)/);
  // A name the desk does not carry is listed, and has nowhere to open.
  await expect(positions(page).getByRole("listitem").filter({ hasText: "IWM" }).locator("[data-greeks]")).toHaveCount(0);
  await expect(positions(page).getByRole("listitem").filter({ hasText: "IWM" }).getByRole("button")).toHaveCount(0);
  // Opening the SPY position selects SPY (on a phone, opens it) and loads what is held into the contract pane.
  await positions(page).getByRole("button", { name: /^SPY/ }).click();
  await expect(detail(page, "SPY")).toBeVisible();
  await expect(page).toHaveURL(/s=SPY/);
  await expect(contract(page)).toHaveAttribute("data-contract", "ready");
  await expect(contract(page).getByRole("button", { name: "Call", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(contract(page).getByLabel("Contracts")).toHaveValue("2");
  await expect(contract(page).getByLabel("Paid, per share")).toHaveValue("2.85");
  // 2.85 a share, 100 shares, two contracts.
  await expect(contract(page)).toContainText("$570");
  expect((await desk(page).textContent()) ?? "").not.toMatch(/NaN|undefined|Infinity/);
  await expect(page.locator("[data-pane-error]")).toHaveCount(0);
});

test("the brief view prices an at-the-money call and put on every name, only when asked", async ({ page, context, baseURL }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/chain")) asked.push(new URL(r.url()).searchParams.get("s") ?? "");
  });
  await open(page, "/options?view=brief");
  const costs = page.getByRole("region", { name: "Option costs" });
  // Shut until asked for: reading the levels fetches no option quote.
  await expect(costs).toHaveAttribute("data-costs", "closed");
  expect(asked).toEqual([]);
  await costs.getByRole("button", { name: "Show at-the-money costs" }).click();
  await expect(costs).toHaveAttribute("data-costs", "ready");
  expect(new Set(asked).size).toBe(10);
  // Every name has a line with an ask for the call and the put, and the distance to breakeven under it.
  const spy = costs.locator('[data-cost-row="SPY"]').first();
  await expect(spy.getByRole("cell").first()).toContainText(/\d\.\d\d/);
  await expect(spy.getByRole("cell").first()).toContainText(/mv|past/);
  // Ten names, a near and a swing line each, every one with an ask on both sides.
  await expect(costs.locator("[data-cost-row]")).toHaveCount(20);
  for (const row of await costs.locator("[data-cost-row]").all()) {
    await expect(row.getByRole("cell").first()).toContainText(/\d\.\d\d/);
    await expect(row.getByRole("cell").last()).toContainText(/\d\.\d\d/);
  }
  await expect(costs.locator("[data-costs-age]")).toHaveAttribute("data-costs-age", "fresh");
  await expect(costs.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect((await costs.textContent()) ?? "").not.toMatch(/NaN|undefined|Infinity/);
  // It belongs to the brief: the live view has the positions there instead.
  await open(page, "/options?view=live");
  await expect(page.getByRole("region", { name: "Option costs" })).toHaveCount(0);
  // With no option feed it says so once, and nothing else on the desk changes.
  await variant(context, baseURL, "chain-off");
  await open(page, "/options?view=brief");
  await page.getByRole("region", { name: "Option costs" }).getByRole("button", { name: "Show at-the-money costs" }).click();
  await expect(page.getByRole("region", { name: "Option costs" })).toHaveAttribute("data-costs", "off");
  await expect(page.getByRole("region", { name: "Option costs" }).getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(rows(page)).toHaveCount(10);
});

test("the live view lists the rules that have triggered today, and each name's rules say where they stand", async ({ page, context, baseURL }) => {
  await open(page, "/options?view=live");
  const today = page.getByRole("region", { name: "Rules today" });
  // Two rules have triggered in the fixture's session: one at its target, one still open. Latest first.
  await expect(today).toHaveAttribute("data-triggers", "2");
  const items = today.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Target reached");
  await expect(items.nth(0)).toContainText("on the 12:00 ET hourly close");
  await expect(items.nth(1)).toContainText("Open");
  await expect(items.nth(1)).toContainText("+0.42R");
  // It says what it is: provisional, behind the market, and not a signal.
  await expect(today).toContainText("16 min behind");
  await expect(today).toContainText("not a signal to trade");
  expect((await today.textContent()) ?? "").not.toMatch(/NaN|undefined|brk_|reject_|reclaim_/);
  await expect(today).toHaveAttribute("data-rules-age", "fresh");
  // A row opens its name (not the one the desk opened on), whose own rule list carries today's state.
  const other = await items.nth(0).getAttribute("data-trigger");
  expect(other).not.toBe("SPY");
  await items.nth(0).getByRole("button").click();
  await expect(detail(page, other!)).toBeVisible();
  await expect(detail(page, other!).locator('[data-rule-today="target"]')).toContainText("triggered on the 12:00 ET close, target reached");
  await expect(detail(page, other!).locator('[data-rule-today="waiting"]')).toHaveCount(3);
  // The host silent for three hours with the market open: the states stay, with a warning.
  await variant(context, baseURL, "positions-old");
  await open(page, "/options?view=live");
  await expect(page.getByRole("region", { name: "Rules today" })).toHaveAttribute("data-rules-age", "old");
  await expect(page.getByRole("region", { name: "Rules today" }).getByRole("status")).toContainText("may be out of date");
  // Nothing triggered: the pane says so. No rule states from the host: no pane, and the desk as it was.
  const notices = page.locator("[data-trigger-notice]");
  await expect(notices).toHaveCount(0); // what had triggered before the page opened is not announced
  await variant(context, baseURL, "rules-none");
  await open(page, "/options?view=live");
  await expect(page.getByRole("region", { name: "Rules today" })).toContainText("No rule has triggered so far");
  // Two rules trigger while the page is open: the next refresh announces each once, and the desk does not move.
  const top = await rows(page).first().boundingBox();
  await variant(context, baseURL, "");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(notices).toHaveCount(2);
  expect((await rows(page).first().boundingBox())?.y).toBeCloseTo(top!.y, 0);
  await expect(notices.first()).toContainText("paper rule triggered on the 12:00 ET hourly close");
  await expect(notices.first()).toContainText("not a signal to trade");
  await expect(page.locator("[data-trigger-notices]").getByRole("status")).toContainText("2 paper rules triggered");
  await page.getByRole("button", { name: "Dismiss the notice for SPY" }).click();
  await expect(notices).toHaveCount(1);
  // Dismissing does not speak again, and the keyboard is back on the desk.
  await expect(page.locator("[data-trigger-notices]").getByRole("status")).toContainText("2 paper rules triggered");
  await expect(page.locator("body")).not.toBeFocused();
  await notices.getByRole("button", { name: `Show ${other}` }).click();
  await expect(detail(page, other!)).toBeVisible();
  await expect(notices).toHaveCount(0);
  await variant(context, baseURL, "rules-off");
  await open(page, "/options?view=live");
  await expect(page.getByRole("region", { name: "Rules today" })).toHaveCount(0);
  await expect(positions(page)).toBeVisible();
  // It belongs to the live view.
  await variant(context, baseURL, "");
  await open(page, "/options?view=brief");
  await expect(page.getByRole("region", { name: "Rules today" })).toHaveCount(0);
});

test("the map marks the strikes with the most open interest, and the layer can be switched off", async ({ page, context, baseURL }) => {
  await open(page, "/options?view=live&s=SPY");
  await showPane(page, "SPY");
  const marks = detail(page, "SPY").locator('[data-layer="oi"]');
  // Two strikes carry open interest in the fixture; the at-the-money one has calls and puts.
  await expect(marks).toHaveAttribute("data-interest", "3");
  await expect(marks.locator("text").first()).toContainText(/\d(k|M)? [CP]$/);
  const toggle = detail(page, "SPY").getByRole("group", { name: "Map layers" }).getByRole("button", { name: "Open interest" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(marks).toBeHidden();
  // A name the host sent nothing for has no marks and no switch for them.
  await pick(page, "NVDA");
  await expect(detail(page, "NVDA")).toBeVisible();
  await expect(detail(page, "NVDA").locator('[data-layer="oi"]')).toHaveCount(0);
  await expect(detail(page, "NVDA").getByRole("button", { name: "Open interest" })).toHaveCount(0);
  // Until the host publishes, there is none anywhere.
  await variant(context, baseURL, "positions-off");
  await open(page, "/options?view=live&s=SPY");
  await showPane(page, "SPY");
  await expect(detail(page, "SPY").locator('[data-layer="oi"]')).toHaveCount(0);
});

test("the paper positions say when there are none, warn when they have gone stale, and are absent until published", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "positions-none");
  await open(page, "/options?view=live");
  await expect(positions(page)).toHaveAttribute("data-positions", "empty");
  await expect(positions(page)).toContainText("No open option positions in the paper account");
  // Three hours old with the market open: still shown, with a warning that says how old.
  await variant(context, baseURL, "positions-old");
  await open(page, "/options?view=live");
  await expect(positions(page)).toHaveAttribute("data-positions", "old");
  await expect(positions(page).getByRole("status")).toContainText("minutes old");
  await expect(positions(page).getByRole("listitem")).toHaveCount(3);
  // Nothing published yet, which is production until the host's job runs: no pane, and the desk as it was.
  await variant(context, baseURL, "positions-off");
  await open(page, "/options?view=live");
  await expect(positions(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(10);
  await expect(page.locator("[data-pane-error]")).toHaveCount(0);
});

test("an edition in the second format shows the day's context and each name's volatility; the first format shows neither", async ({ page, context, baseURL, isMobile }) => {
  // The first format, which is what production has until the engine sends the second: no line, no extra facts.
  await open(page, "/options?view=brief&s=SPY");
  await expect(page.locator("[data-desk-day]")).toHaveCount(0);
  await showPane(page, "SPY");
  await expect(page.locator('[data-desk-detail="SPY"]')).not.toContainText("IV against realised");
  // The second format.
  await variant(context, baseURL, "v2");
  await open(page, "/options?view=brief&s=SPY");
  const day = page.locator("[data-desk-day]");
  await expect(day).toBeVisible();
  await expect(day).toContainText("VIX 16.24");
  // The session's own releases in time order, each time marked as New York's. A code the site has no name for is
  // never drawn as written: the fixture's one spells out a headline.
  await expect(day).toContainText(/CPI inflation 08:30 ET.*Fed minutes 14:00 ET.*Other release/);
  await expect(day).not.toContainText(/powell|hawkish/i);
  await expect(day).not.toContainText("ZZZZ");
  // The rest of the line is in view on a wide screen and one tap away on a phone. Each copy is checked where it
  // is the one on screen: text alone would be found in the hidden copy too.
  const rest = isMobile ? day.locator("[data-day-more]") : day.locator("[data-day-wide]");
  if (isMobile) {
    await expect(day.getByText("Next 6 days", { exact: false }).last()).toBeHidden();
    await day.locator("summary").click();
  }
  for (const text of ["Next 6 days: Fed decision Wed 14 Oct 14:00 ET", "Earnings, next 6 days: SPY Tue 13 Oct before the open", "09:30 to 16:00"]) {
    await expect(rest.getByText(text, { exact: false })).toBeVisible();
  }
  await showPane(page, "SPY");
  const facts = page.locator('[data-desk-detail="SPY"]');
  await expect(facts).toContainText("IV against realised");
  await expect(facts).toContainText("1.32×");
  await expect(facts).toContainText("+1.2 pts");
  // A name the edition gives no block: none of the extra facts, and nothing broken.
  await pick(page, "MSFT");
  await expect(page.locator('[data-desk-detail="MSFT"]')).toBeVisible();
  await expect(page.locator('[data-desk-detail="MSFT"]')).not.toContainText("IV against realised");
  // A name with a block of blanks: the facts are there, as dashes.
  await pick(page, "NVDA");
  await expect(page.locator('[data-desk-detail="NVDA"]')).toContainText(/IV against realised\s*—/);
  await expect(page.locator('[data-desk-detail="NVDA"]')).toContainText(/Option volume\s*—/);
  expect((await desk(page).textContent()) ?? "").not.toMatch(/NaN|undefined|Infinity|null/);
  await expect(page.locator("[data-pane-error]")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
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
  await pick(page, "AAPL");
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
  await showPane(page, "SPY");
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

test("a name has a page of its own, reached from the desk and leading back to it", async ({ page }) => {
  await open(page, "/options?view=live&s=AAPL");
  await showPane(page, "AAPL");
  await detail(page, "AAPL").locator("[data-full-page]").click();
  await expect(page).toHaveURL(/\/options\/AAPL$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("AAPL, Options");
  await expect(detail(page, "AAPL")).toBeVisible();
  await expect(page.locator("[data-desk-row]")).toHaveCount(0); // the list stays on the desk
  await expect(page.getByRole("list", { name: "AAPL zones, highest first" })).toBeVisible(); // open from the start here
  await expect(detail(page, "AAPL").locator("[data-full-page]")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("navigation", { name: "Back" }).getByRole("link", { name: "All names" }).click();
  await expect(page).toHaveURL(/\/options\?s=AAPL$/);
  await expect(desk(page)).toBeVisible();
  // A lower-case address is the same name; a name the edition does not carry is not a page.
  await openName(page, "aapl");
  await expect(detail(page, "AAPL")).toBeVisible();
  // The page streams behind its loading outline, so the status is already sent when it finds no such name: it says so.
  for (const path of ["/options/ZZZZ", "/options/not%20a%20name"]) {
    await page.goto(path);
    await expect(page.getByText("This page does not exist")).toBeVisible();
    await expect(page.locator("[data-desk-detail]")).toHaveCount(0);
  }
});

test("pointing at a zone on the map picks it out in the list, and the reverse", async ({ page, isMobile }) => {
  test.skip(isMobile, "a pointer that hovers is a desktop's");
  await openName(page, "AAPL");
  const pane = detail(page, "AAPL");
  const rowsOf = pane.locator("[data-zone-row]");
  const key = await rowsOf.first().getAttribute("data-zone-row");
  expect(key).toMatch(/^[\d.]+:[\d.]+$/);
  await expect(pane.locator("[data-hot]")).toHaveCount(0);
  await rowsOf.first().hover();
  await expect(rowsOf.first()).toHaveAttribute("data-hot", "");
  // The same zone on the map, when the map's window reaches it.
  const onMap = pane.locator(`rect[data-zone="${key}"]`);
  if ((await onMap.count()) > 0) await expect(onMap).toHaveAttribute("data-hot", "");
  await page.mouse.move(0, 0);
  await expect(pane.locator("[data-hot]")).toHaveCount(0);
  // And from the map to the list: the crosshair's height decides, whatever is drawn over the zone there.
  await page.evaluate(() => window.scrollTo(0, 0));
  const drawn = pane.locator("rect[data-zone]").first();
  const box = (await drawn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // One zone is picked out (the heaviest at that price), and it is the same one in the list and on the map.
  await expect(pane.locator("[data-zone-row][data-hot]")).toHaveCount(1);
  const picked = await pane.locator("[data-zone-row][data-hot]").getAttribute("data-zone-row");
  await expect(pane.locator(`rect[data-zone="${picked}"]`).first()).toHaveAttribute("data-hot", "");
  await page.mouse.move(0, 0);
  await expect(pane.locator("[data-hot]")).toHaveCount(0);
});

test("the rows can be made compact, the choice is remembered, and a phone keeps its tall rows", async ({ page, context, baseURL, isMobile }) => {
  // With no live prices every row is one line of text, whatever the hour. With them a row can hold two chips, one
  // under the other (a state and STALE), which no density makes shorter: the test then failed after the close.
  await variant(context, baseURL, "quotes-off");
  await open(page, "/options?view=live");
  await expect(desk(page)).toHaveAttribute("data-desk-density", "comfortable");
  const tall = (await rows(page).first().boundingBox())!.height;
  await rows(page).first().getByRole("button").focus();
  await page.keyboard.press("d");
  await expect(desk(page)).toHaveAttribute("data-desk-density", "compact");
  const now = (await rows(page).first().boundingBox())!.height;
  if (isMobile) expect(now).toBe(tall);
  else expect(now).toBeLessThan(tall);
  await open(page, "/options?view=live");
  await expect(desk(page)).toHaveAttribute("data-desk-density", "compact");
  await rows(page).first().getByRole("button").focus();
  await page.keyboard.press("d");
  await expect(desk(page)).toHaveAttribute("data-desk-density", "comfortable");
});

test("the review says how the in-session rule states compared with the record, only when both are for the same session", async ({ page, context, baseURL }) => {
  await open(page, "/options?view=review");
  await expect(page.locator("[data-agreement]")).toHaveCount(0); // mid-session states: nothing to compare yet
  await variant(context, baseURL, "rules-final");
  await open(page, "/options?view=review");
  await expect(page.locator("[data-agreement]")).toContainText("only in session");
  await expect(page.locator("[data-agreement]")).toContainText("10 names");
  // A damaged paper record breaks the scorecard and not the desk, here as everywhere.
  await variant(context, baseURL, "poison.rules-final");
  await open(page, "/options?view=review");
  await expect(rows(page)).toHaveCount(10);
  await variant(context, baseURL, "rules-final");
  await open(page, "/options?view=live");
  await expect(page.locator("[data-agreement]")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Rules today" })).toHaveCount(0); // yesterday's states are not today's
});

test("the map can be switched to hourly candles when the host has sent them, and back", async ({ page, context, baseURL }) => {
  await open(page, "/options?view=live&s=SPY");
  await showPane(page, "SPY");
  const pane = detail(page, "SPY");
  const range = pane.getByRole("group", { name: "Map range" });
  const map = pane.locator("[data-map-range]");
  await expect(map).toHaveAttribute("data-map-range", "daily");
  const daily = await map.locator('[data-layer="candles"] > g').count();
  await range.getByRole("button", { name: "Hourly" }).click();
  await expect(map).toHaveAttribute("data-map-range", "hourly");
  await expect(map.locator('[data-layer="candles"] > g')).toHaveCount(35);
  expect(daily).not.toBe(35);
  await expect(range).toContainText("35 finished hourly bars from the delayed tape");
  await expect(map.getByRole("img")).toHaveAccessibleName(/SPY: last 35 hourly bars/);
  await expect(map.locator('[data-layer="zones"] rect').first()).toBeAttached(); // the same zones, behind other candles
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The choice holds for the next name; a name the host sent no bars for is drawn daily, with nothing to switch.
  await pick(page, "AAPL");
  await showPane(page, "AAPL");
  await expect(detail(page, "AAPL").locator("[data-map-range]")).toHaveAttribute("data-map-range", "hourly");
  await pick(page, "PLTR");
  await showPane(page, "PLTR");
  await expect(detail(page, "PLTR").getByRole("group", { name: "Map range" })).toHaveCount(0);
  await expect(detail(page, "PLTR").locator("[data-map-range]")).toHaveAttribute("data-map-range", "daily");
  // Back on a name with bars the choice is still hourly, and Daily returns the edition's candles.
  await pick(page, "SPY");
  await showPane(page, "SPY");
  await expect(map).toHaveAttribute("data-map-range", "hourly");
  await range.getByRole("button", { name: "Daily" }).click();
  await expect(map.locator('[data-layer="candles"] > g')).toHaveCount(daily);
  // No bars from the host at all: no switch, and the map as it always was.
  await variant(context, baseURL, "hourly-off");
  await open(page, "/options?view=live&s=SPY");
  await showPane(page, "SPY");
  await expect(detail(page, "SPY").getByRole("group", { name: "Map range" })).toHaveCount(0);
  await expect(detail(page, "SPY").locator("[data-map-range]")).toHaveAttribute("data-map-range", "daily");
});
