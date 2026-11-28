import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// CI-only. The "Trade now" board on the Options desk, on the scripted morning (`quotes-script`, fixture-script.ts):
// the `fxstep` cookie holds the step, and the feed's answer is dated at it, so the board reads the step's clock
// whatever the browser's clock says.

async function at(context: BrowserContext, baseURL: string | undefined, step: number) {
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script", url: baseURL! },
    { name: "fxstep", value: String(step), url: baseURL! },
  ]);
}

// The board itself; before the open it folds into the status rail, whose countdown then carries its marks (its line
// is the hero's headline, not repeated on the rail).
const board = (page: Page) => page.locator("[data-trade-now]");
const boardSection = (page: Page) => page.locator("section[data-trade-now]");
const hero = (page: Page) => page.locator("[data-now-hero]");
const rail = (page: Page) => page.locator("[data-status-rail]");
const rows = (page: Page) => board(page).locator("[data-board-row]");

test("lists only the names worth acting on, most urgent first, and counts the rest", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-trade-now", "live");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(rows(page)).toHaveCount(2);
  expect(await rows(page).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-board-row")}:${e.getAttribute("data-board-state")}`))).toEqual([
    "QQQ:enter_zone",
    "SPY:plan_off",
  ]);
  // AAPL, in the middle of yesterday's range, is only counted
  await expect(board(page).locator("[data-board-hidden]")).toHaveText("1 more name watching: see the glance above");
  // the entry and the live failed break open up with their numbers; the runner plan stays folded
  await expect(board(page).locator('[data-expanded="true"]')).toHaveCount(2);
  const entry = rows(page).first();
  await expect(entry).toContainText("ENTER ZONE · CALL");
  await expect(entry).toContainText("Retest confirmed at 753.19: call setup ready. 753.19 is $0.24 past the card entry; to the stop $1.18, not $0.94");
  await expect(entry.locator("[data-board-grid]")).toContainText("~752.95");
  await expect(entry).toContainText("Semis against");
  await expect(entry.locator("[data-board-runner]")).not.toHaveAttribute("open", "");
  await expect(entry.getByText(/^Sell half at/)).toBeHidden();
  await entry.getByText("Runner plan").click();
  await expect(entry.getByText(/^Sell half at/)).toBeVisible();
  const spy = rows(page).nth(1);
  await expect(spy).toContainText("FAILED BREAK · PUT");
  await expect(spy.locator("[data-testing-tag]")).toBeVisible();
  await expect(board(page).getByRole("link", { name: /Testing · not proven yet/ })).toHaveAttribute("href", "/strategies");
});

test("before 09:35 the board folds into the rail, and the hero shows the #1 name's triggers", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 0);
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-trade-now", "opening");
  await expect(rail(page).locator("[data-trade-now]")).toHaveAttribute("data-board-status", "waiting");
  // the board's line is said once, as the hero's headline, not again on the rail
  await expect(hero(page).locator("[data-hero-line]")).toHaveText("Opening range forming: first entries from 09:35 New York");
  await expect(rail(page)).not.toContainText("Opening range forming");
  await expect(boardSection(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
  // the trigger prices live on the hero, the ladders and the cards now
  await expect(hero(page)).toHaveAttribute("data-now-hero", "opening");
  await expect(hero(page).locator("[data-hero-line]")).toContainText("Opening range forming");
  await expect(hero(page).locator('[data-hero-tile="call"]')).toContainText("Calls above");
  await expect(hero(page).locator('[data-hero-tile="put"]')).toContainText("Puts below");
  await expect(rail(page).locator("[data-rail-countdown]")).toHaveText(/^First entries in \d:\d\d$/);
});

test("with the live prices off it says so and draws no rows", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "focus.quotes-off", url: baseURL! }]);
  // With no feed the board reads the browser's clock: stand it on the fixture's session, or the card reads as old.
  await page.clock.setFixedTime(new Date("2026-10-12T14:31:00Z"));
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-trade-now", "off");
  await expect(board(page)).toContainText("Live prices off: use the plans below");
  await expect(rows(page)).toHaveCount(0);
  // the hero keeps the #1 name's triggers, greyed, and says the plan is on the cards
  await expect(hero(page).locator("[data-hero-triggers]")).toHaveAttribute("data-hero-triggers", "grey");
  await expect(hero(page)).toContainText("Live prices are off: the plan is on the cards below.");
  await expect(hero(page)).not.toContainText("Enter only on a break");
});

test("a notice fires once when a name enters the zone or its plan goes off", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 2);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  await expect(page.locator("[data-board-notice]")).toHaveCount(0);
  await at(context, baseURL, 3);
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone", { timeout: 15_000 });
  await expect(page.locator("[data-board-notice]")).toHaveCount(2);
  await expect(page.locator('[data-board-notice="QQQ"]')).toContainText("QQQ: ENTER ZONE, call");
  // more polls of the same step announce nothing new
  await page.waitForTimeout(5_000);
  await expect(page.locator("[data-board-notice]")).toHaveCount(2);
  await page.getByRole("button", { name: "Dismiss the notice for QQQ" }).click();
  await expect(page.locator("[data-board-notice]")).toHaveCount(1);
});

test("an old focus card hides the rows and says which day it is for", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "focus.quotes-off", url: baseURL! }]);
  await page.clock.setFixedTime(new Date("2026-10-14T14:31:00Z"));
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-trade-now", "old");
  await expect(board(page)).toContainText("Focus card is for Mon 12 Oct");
  await expect(rows(page)).toHaveCount(0);
  // no old triggers in the hero, and the rail's clock is today's (Wed 14 Oct, 10:31: open), never "Closed"
  await expect(hero(page).locator('[data-hero-tile="call"]')).toHaveCount(0);
  await expect(hero(page).locator("[data-hero-triggers]")).toHaveAttribute("data-hero-triggers", "none");
  await expect(rail(page).locator("[data-rail-countdown]")).toHaveText(/^Lunch block 11:30–13:00 in /);
});

test("on a phone one notice shows at a time, below the board, with a count of the rest", async ({ page, context, baseURL, isMobile }) => {
  test.skip(!isMobile, "the phone's layout");
  await at(context, baseURL, 2);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  await at(context, baseURL, 3);
  await expect(page.locator("[data-board-notice]")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator("[data-board-notice]:visible")).toHaveCount(1);
  await expect(page.locator("[data-board-more]")).toHaveText("+1 more");
  const b = (await board(page).boundingBox())!;
  const n = (await page.locator("[data-board-notice]:visible").boundingBox())!;
  expect(n.y >= b.y + b.height || n.y + n.height <= b.y).toBe(true);
});

test("on a phone the alert switches sit behind one bell", async ({ page, context, baseURL, isMobile }) => {
  test.skip(!isMobile, "the phone's layout");
  await at(context, baseURL, 3);
  await page.goto("/options");
  const bell = page.getByRole("button", { name: /^Alerts:/ });
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#trade-now-alerts").getByRole("button", { name: "Sound", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await expect(bell).toBeFocused();
});

test("tapping a row, or a name on the glance, brings its focus card into view", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await rows(page).filter({ hasText: "SPY" }).getByRole("button").first().click();
  await expect(page.locator("#focus-card-SPY")).toBeFocused();
  await page.locator('[data-glance="AAPL"]').getByRole("button").click();
  await expect(page.locator("#focus-card-AAPL")).toBeFocused();
});

test("the glance shows each focus name's ladder with the board's own state chip", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(page.locator("[data-glance]")).toHaveCount(3);
  await expect(page.locator('[data-glance="QQQ"]')).toHaveAttribute("data-glance-state", "enter_zone");
  await expect(page.locator('[data-glance="QQQ"]')).toContainText("ENTER ZONE · CALL");
  await expect(page.locator('[data-glance="QQQ"] [data-testid="ladder-mini-QQQ"]')).toBeVisible();
  await expect(page.locator('[data-glance="AAPL"]')).toHaveAttribute("data-glance-state", "no_trade");
});

test("the hero shows the most urgent name: its state word, side and the three numbers", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(hero(page)).toHaveAttribute("data-now-hero", "live");
  await expect(hero(page)).toHaveAttribute("data-hero-for", "QQQ");
  await expect(hero(page).locator('[data-hero-word="enter_zone"]')).toHaveText("ENTER ZONE");
  await expect(hero(page).locator("[data-hero-side]")).toHaveText("CALL");
  await expect(hero(page).locator('[data-hero-tile="in"]')).toContainText("In~752.95");
  await expect(hero(page).locator('[data-hero-tile="stop"]')).toContainText("Stop752.01");
  await expect(hero(page).locator('[data-hero-tile="t1"]')).toContainText("T1754.83");
  await expect(hero(page)).toContainText("Semis against");
  await expect(hero(page).locator('[data-hero-price="live"]')).toBeVisible();
  // read only: no tile reads as an order
  await expect(hero(page)).not.toContainText(/\b(Buy|Order)\b/);
  // 10:41: QQQ ran past target 1 without you; no name is worth acting on, and the hero says so with no numbers
  await at(context, baseURL, 4);
  await expect(hero(page).locator('[data-hero-word="enter_zone"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(boardSection(page).locator("[data-board-none]")).toContainText("Nothing to act on: 3 names watching");
});

test("the what-if checks: the hero prices the at-the-money option against the cap, and AAPL waits inside its box", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(hero(page)).toHaveAttribute("data-hero-for", "QQQ");
  await expect(hero(page).locator('[data-hero-word="enter_zone"]')).toBeVisible();
  // The fixture chain answers for QQQ (no chain-off flag), dated by the server's own clock with its quotes 15 minutes
  // behind: fresh. Whether the ask is over $2.00 depends on how long the fixture's nearest expiry has left, so only the
  // shape is asserted.
  const checks = hero(page).locator("[data-hero-checks]");
  await expect(checks.locator("[data-hero-premium]")).toHaveAttribute("data-hero-premium", /^(over|under)$/, { timeout: 15_000 });
  await expect(checks.locator("[data-hero-premium]")).toContainText(/^ATM call \d+ ask \$\d+\.\d\d \(\$[\d,]+ a contract\), (within|over) the \$2\.00 cap \(\$200\)/);
  await expect(checks.locator("[data-hero-chain]")).toContainText(/^Option chain \d\d:\d\d NY · 15 min behind$/);
  // Which stop comes first follows the same clock (the option's premium and delta shrink toward the bell), and at
  // some times of day the two land within half a cent of each other: all three answers are right, so only the shape
  // is asserted here. test/what-if.test.ts pins each answer on fixed numbers.
  const stopFirst = checks.locator("[data-hero-stop-first]");
  await expect(stopFirst).toHaveAttribute("data-hero-stop-first", /^(option|chart|together)$/);
  await expect(stopFirst).toContainText(/(option stop comes first|chart stop comes first|land about together)/);
  // the checks sit under the tiles, never above the state word
  const word = (await hero(page).locator('[data-hero-word="enter_zone"]').boundingBox())!;
  const tiles = (await hero(page).locator("[data-hero-tiles]").boundingBox())!;
  const box = (await checks.boundingBox())!;
  expect(box.y).toBeGreaterThan(word.y);
  expect(box.y).toBeGreaterThanOrEqual(tiles.y + tiles.height - 1);
  await expect(hero(page)).not.toContainText(/\b(Buy|Order|Place)\b/);
  // AAPL sits at 334.63, strictly between its floor 330.70 and ceiling 338.60, on a live price with no trade: the card
  // says so beside the board's chip. QQQ (an entry) and SPY (a live alternative) never carry it.
  await expect(page.locator("#focus-card-AAPL [data-focus-state]")).toHaveAttribute("data-focus-state", "no_trade");
  await expect(page.locator("#focus-card-AAPL [data-inside-box]")).toHaveText("INSIDE BOX · wait");
  await expect(page.locator("#focus-card-QQQ [data-inside-box]")).toHaveCount(0);
  await expect(page.locator("#focus-card-SPY [data-inside-box]")).toHaveCount(0);
});

test("with the option feed off the hero shows no premium check, never an old number", async ({ page, context, baseURL }) => {
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script.chain-off", url: baseURL! },
    { name: "fxstep", value: "3", url: baseURL! },
  ]);
  // Wait for the chain request to have answered "not configured" before asserting what is absent, so the check is not
  // passing only because nothing has answered yet.
  const off = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/chain" && r.status() === 503, { timeout: 20_000 });
  await page.goto("/options");
  await expect(hero(page).locator('[data-hero-word="enter_zone"]')).toBeVisible();
  await off;
  await expect(hero(page).locator("[data-hero-premium]")).toHaveCount(0);
  await expect(hero(page).locator("[data-hero-stop-first]")).toHaveCount(0);
});

test("frozen prices grey the hero and say for how long, with no entry shown", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(hero(page).locator('[data-hero-word="enter_zone"]')).toBeVisible();
  // the feed stops answering: the board's clock runs on past the stale limit
  await page.route("**/api/quote**", (route) => route.abort());
  await expect(hero(page)).toHaveAttribute("data-hero-state", "paused", { timeout: 40_000 });
  await expect(hero(page).locator("[data-hero-stale]")).toContainText(/Prices paused \d+ s/);
  await expect(hero(page).locator("[data-hero-tiles]")).toHaveCount(0);
  await expect(hero(page)).not.toContainText("ENTER ZONE");
});

test("the rail shows the day, the New York clock's next boundary and the session bar", async ({ page, context, baseURL, isMobile }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(rail(page).locator("[data-rail-day]")).toContainText(/trades · \$\d+ of \$100/);
  await expect(rail(page).locator("[data-rail-countdown]")).toHaveText(/^Lunch block 11:30–13:00 in /);
  await expect(rail(page).locator("[data-session-bar] [data-window]")).toHaveCount(3);
  await expect(rail(page).locator("[data-now-tick]")).toBeVisible();
  // From sm up the rail stays in view as the page scrolls; on a phone it is not sticky (it would hold a quarter of the
  // screen), so it scrolls away with the page.
  await page.mouse.wheel(0, 2000);
  if (isMobile) await expect(rail(page)).not.toBeInViewport();
  else await expect(rail(page)).toBeInViewport();
});

test("the Today log lists a state change, newest first, and closes on Escape", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 2);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "get_ready");
  await at(context, baseURL, 3);
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone", { timeout: 15_000 });
  const button = page.getByRole("button", { name: /^Today · \d+/ });
  await button.click();
  const log = page.locator("[data-today-log]");
  await expect(log.locator('[data-log-line="QQQ"]').first()).toContainText(/^10:2\d\s*QQQ\s*ENTER ZONE · CALL$/);
  await page.keyboard.press("Escape");
  await expect(log).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("the cockpit keeps the rail, the hero and the large ladders, survives a reload and leaves on Escape", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  const desk = page.getByRole("region", { name: "Options desk" });
  await expect(desk).toBeVisible();
  const toggle = page.locator("[data-cockpit-switch]");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(desk).toBeHidden();
  await expect(boardSection(page)).toBeHidden();
  await expect(page.locator("[data-focus-glance]")).toBeHidden();
  await expect(rail(page)).toBeVisible();
  await expect(hero(page)).toBeVisible();
  // the hero's "Show the card" has no card to show in the cockpit; the notices stay
  await expect(hero(page).getByRole("button", { name: /^Show the \w+ card$/ })).toBeHidden();
  await expect(page.locator("[data-board-notices]")).toHaveCount(1);
  // one large ladder per focus name (the fixture has three; a live card has four)
  await expect(page.locator('[data-cockpit-ladders] figure[data-testid^="ladder-"]')).toHaveCount(3);
  await page.reload();
  await expect(page.locator("[data-cockpit-switch]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-cockpit-ladders]")).toBeVisible();
  await expect(desk).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-cockpit-switch]")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-cockpit-ladders]")).toHaveCount(0);
  await expect(desk).toBeVisible();
});

test("fits a 375 px screen with no sideways scroll", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  // Names whatever sticks out past the right edge (and is not clipped by a scrolling parent), so a failure says where.
  const sticking = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const e of document.querySelectorAll("body *")) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.right <= w + 1) continue;
      // clipped by any parent that scrolls or hides its overflow and itself ends inside the screen (the focus cards'
      // swipe strip runs past the edge on purpose, inside its own scroller)
      // A scroller clips a box only when it is the box's containing block or an ancestor of it. For an absolutely
      // positioned box that chain starts at its offsetParent (the nearest positioned ancestor), so a scroller between
      // the box and that parent does not clip it: that is how the ladders' hidden screen-reader text once escaped the
      // cards' strip and widened the page. A fixed box is clipped by none.
      const pos = getComputedStyle(e).position;
      const start = pos === "fixed" ? null : pos === "absolute" ? ((e as HTMLElement).offsetParent ?? null) : e.parentElement;
      let clipped = false;
      for (let p = start; p && !clipped; p = p.parentElement)
        clipped = getComputedStyle(p).overflowX !== "visible" && p.getBoundingClientRect().right <= w + 1;
      if (clipped) continue;
      // the element and its parents up to the nearest one with a data- attribute, each with its width
      const chain: string[] = [];
      for (let a: Element | null = e; a && chain.length < 8; a = a.parentElement) {
        const data = [...a.attributes].filter((x) => x.name.startsWith("data-")).map((x) => `${x.name}=${x.value}`).join(",");
        chain.push(`${a.tagName.toLowerCase()}${data ? `[${data}]` : ""}@${Math.round(a.getBoundingClientRect().width)}`);
        if (data && a !== e) break;
      }
      out.push(`${Math.round(r.right)}px ${chain.join(" < ")}`);
    }
    return out.slice(0, 8);
  });
  // The verdict is the page's own scroll width; the list of what reaches past the edge is only the message, since
  // telling from the outside which scroller clips a box (SVGs have no offsetParent, for one) is not exact.
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `the page scrolls sideways by ${over} px; reaching past the edge:\n${sticking.join("\n")}`).toBeLessThanOrEqual(0);
  for (const part of [board(page), hero(page), rail(page), page.locator("[data-focus-glance]")]) {
    const box = await part.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  }
  // each glance chip wraps inside its tile ("FAILED BREAK · PUT" is wider than a phone's tile): nothing clipped
  for (const tile of await page.locator("[data-glance]").all()) {
    const t = (await tile.boundingBox())!;
    const chip = tile.locator("[data-chip-state]");
    if (!(await chip.count())) continue;
    const c = (await chip.boundingBox())!;
    expect(c.x).toBeGreaterThanOrEqual(t.x);
    expect(c.x + c.width).toBeLessThanOrEqual(t.x + t.width);
  }
  // the hero's tiles fit too: two and one on a phone
  for (const tile of await hero(page).locator("[data-hero-tile]").all()) {
    const b = (await tile.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(375);
    expect(await tile.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  }
  // on a phone the rail is not sticky (it scrolls away with the page), but it still leaves the hero room on the
  // first screen: no more than 40% of it
  expect((await rail(page).boundingBox())!.height).toBeLessThanOrEqual(812 * 0.4);
});

test("I'm in at the entry opens the manage card, which reads target 1 hit and then exit", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  const entry = rows(page).first();
  await expect(entry).toHaveAttribute("data-board-state", "enter_zone");
  await entry.getByRole("button", { name: "I'm in" }).click();
  const form = page.locator('[data-im-in-form="QQQ"]');
  const price = form.getByLabel("QQQ price at your fill");
  await expect(price).toHaveValue(/^753\.\d\d$/);
  // a price far from the live one is refused in place
  await price.fill("900");
  await form.getByRole("button", { name: "Save note" }).click();
  await expect(form.getByRole("alert")).toContainText("more than 5% from the live price");
  await expect(price).toHaveAttribute("aria-invalid", "true");
  await price.fill("753.43");
  // the fill time starts at the minute the form opened, and a time still to come is refused in place
  const time = form.getByLabel("Filled at (New York, to the minute)");
  await expect(time).toHaveValue("10:28");
  await time.fill("10:59");
  await form.getByRole("button", { name: "Save note" }).click();
  await expect(form.getByRole("alert")).toContainText("That time is still to come");
  await expect(time).toHaveAttribute("aria-invalid", "true");
  await time.fill("10:28");
  await form.getByRole("button", { name: "Save note" }).click();
  const card = page.locator('[data-manage="QQQ"]');
  await expect(card).toContainText("In a trade · QQQ call");
  await expect(card).toContainText("Your own note in this browser");
  await expect(card).toContainText("fill time to the minute");
  await expect(card).toHaveAttribute("data-manage-action", "hold");
  await expect(card.locator("[data-manage-line]")).toContainText("Holding: stop 752.01");
  // a hand note names no contract: no live option value, and the P&L stays with Webull
  await expect(card.locator("[data-manage-value]")).toHaveCount(0);
  await expect(card.locator('[data-manage-small="pnl"]')).toContainText("see Webull");
  await at(context, baseURL, 4);
  await expect(card).toHaveAttribute("data-manage-action", "sell_half", { timeout: 15_000 });
  await expect(card.locator("[data-manage-line]")).toContainText("Target 1 hit: sell half, stop to 753.43");
  await expect(page.locator('[data-manage-notice="QQQ"]')).toContainText("QQQ call: SELL HALF");
  await at(context, baseURL, 5);
  await expect(card).toHaveAttribute("data-manage-action", "exit", { timeout: 15_000 });
  // the stock stop's exit, said as the 2-minute close it is (held-marks.ts withClosedStopLine)
  await expect(card.locator("[data-manage-line]")).toContainText("A 2-min close went below the stop 753.43: exit");
  // the note outlives a reload, and Clear ends it
  await page.reload();
  await expect(card).toHaveAttribute("data-manage-action", "exit");
  await card.getByRole("button", { name: "Clear" }).click();
  await expect(card).toHaveCount(0);
});

test("the I'm in form keeps the side it opened on after the row moves on", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  const entry = rows(page).first();
  await expect(entry).toHaveAttribute("data-board-state", "enter_zone");
  await entry.getByRole("button", { name: "I'm in" }).click();
  const form = page.locator('[data-im-in-form="QQQ"]');
  await expect(form).toHaveAttribute("data-im-in-side", "call");
  await at(context, baseURL, 4);
  // QQQ ran past target 1 without you: the row has left the entry zone (it reads watch, "don't chase", while its put
  // side is still watched), and the form stays as it was opened
  await expect(rows(page).filter({ hasText: "QQQ" })).toHaveAttribute("data-board-state", /^(watch|missed)$/, { timeout: 15_000 });
  await expect(form).toContainText("The board has moved on: this note keeps the call you opened");
  await expect(form).toHaveAttribute("data-im-in-side", "call");
  await form.getByLabel("QQQ price at your fill").fill("753.43");
  await form.getByRole("button", { name: "Save note" }).click();
  const card = page.locator('[data-manage="QQQ"]');
  await expect(card).toContainText("In a trade · QQQ call");
  await expect(card).toHaveAttribute("data-manage-side", "call");
  await card.getByRole("button", { name: "Clear" }).click();
  await expect(card).toHaveCount(0);
});

// `quotes-flaky`: the first quote answers, the next three fail, then every one answers (the route counts them in the
// `fxflaky` cookie). The page tries again at about 2, 4 and 8 s, so it is back well inside the 20 s after which the
// board would pause.
async function flaky(context: BrowserContext, baseURL: string | undefined) {
  await context.addCookies([
    { name: "fx", value: "focus.quotes-script.quotes-flaky", url: baseURL! },
    { name: "fxstep", value: "3", url: baseURL! },
  ]);
}

/** Every paused mark the page draws, watched from its first paint: the board, its rows, the glance chips and the hero. */
async function watchForPaused(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __paused: string[] };
    w.__paused = [];
    const sel = '[data-board-status="paused"],[data-board-state="paused"],[data-chip-state="paused"],[data-hero-state="paused"],[data-board-paused]';
    window.setInterval(() => {
      for (const e of document.querySelectorAll(sel)) w.__paused.push(e.outerHTML.slice(0, 120));
    }, 100);
  });
  return () => page.evaluate(() => (window as unknown as { __paused: string[] }).__paused);
}

const retryLine = (page: Page) => board(page).locator("[data-feed-retry]");

test("a short outage of the live prices is retried within seconds: the board never pauses and ends up live", async ({ page, context, baseURL }) => {
  await flaky(context, baseURL);
  const paused = await watchForPaused(page);
  await page.goto("/options");
  await expect(board(page)).toHaveAttribute("data-board-status", "live");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  // the line is laid over the header row: the rows under it never move as it comes and goes
  const rowY = async () => (await rows(page).first().boundingBox())!.y;
  const before = await rowY();
  // the notice says it is trying again, and in how long, with a button to try now
  await expect(retryLine(page)).toBeVisible({ timeout: 10_000 });
  expect(await rowY()).toBe(before);
  await expect(board(page).locator("[data-feed-retry-spoken]")).toHaveText("Live prices did not answer. Trying again shortly.");
  await expect(retryLine(page)).toContainText(/Live prices did not answer: trying again (now|in \d+s)/);
  await expect(retryLine(page).getByRole("button", { name: "Retry now" })).toBeVisible();
  // three failures wait about 2 + 4 + 8 s: the notice goes, and the board was live throughout
  await expect(retryLine(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(board(page)).toHaveAttribute("data-board-status", "live");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  expect(await rowY()).toBe(before);
  // said once for the screen reader, in words, and cleared again
  await expect(board(page).locator("[data-feed-retry-spoken]")).toHaveText("");
  expect(await paused()).toEqual([]);
  // and it keeps answering every 2 s from then on
  await page.waitForTimeout(5_000);
  await expect(retryLine(page)).toHaveCount(0);
  expect(await paused()).toEqual([]);
});

test("Retry now tries at once: pressed through the outage, the prices are back in a few seconds", async ({ page, context, baseURL }) => {
  await flaky(context, baseURL);
  await page.goto("/options");
  await expect(retryLine(page)).toBeVisible({ timeout: 10_000 });
  const started = Date.now();
  // each press is one attempt (the button waits while one is out, and a press goes out at most once a second); three
  // failures, then an answer
  while (await retryLine(page).count()) {
    const button = retryLine(page).getByRole("button", { name: "Retry now" });
    await button.click({ timeout: 2_000 }).catch(() => undefined); // the line may go between the check and the press
    await page.waitForTimeout(150);
    expect(Date.now() - started, "the presses alone should bring the prices back").toBeLessThan(8_000);
  }
  await expect(board(page)).toHaveAttribute("data-board-status", "live");
});

test("the retry notice fits a 375 px screen with no sideways scroll, moves no row, and is a finger's size to press", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await flaky(context, baseURL);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  const rowY = async () => (await rows(page).first().boundingBox())!.y;
  const before = await rowY();
  await expect(retryLine(page)).toBeVisible({ timeout: 10_000 });
  expect(await rowY()).toBe(before);
  expect((await retryLine(page).getByRole("button", { name: "Retry now" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const box = (await retryLine(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

// ---- where the prices come from, and how old they are ---------------------------------------------------------------
const facts = (page: Page) => board(page).locator("[data-feed-facts]");
/** An age in whole seconds: the newest or the oldest end of the last trades, or the answer's. */
const ageS = async (page: Page, kind: "newest" | "oldest" | "checked") =>
  Number(await facts(page).locator(kind === "checked" ? '[data-feed-age="checked"] [data-age-slot]' : `[data-age-end="${kind}"]`).getAttribute("data-age-s"));
const rowBoxes = (page: Page) => rows(page).evaluateAll((els) => els.map((e) => JSON.stringify(e.getBoundingClientRect())));

/** Every answer as the server sent it, but dated on by the time since the first one: the same trade, fetched again and again. */
async function sameTradeAgain(page: Page, edit: (body: Record<string, unknown>) => void = () => undefined) {
  let first = 0;
  await page.route("**/api/quote**", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    first ||= Date.now();
    body.as_of = new Date(Date.parse(String(body.as_of)) + (Date.now() - first)).toISOString();
    edit(body);
    await route.fulfill({ response: res, json: body });
  });
}

test("the board names the feed the server reported, says it is fetched every 2 s, and gives both ages apart", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(facts(page)).toBeVisible();
  await expect(facts(page).locator("[data-feed-name]")).toHaveText("SIP");                // DEC-0064: unset is sip
  await expect(facts(page).locator("[data-feed-source]")).toHaveText("SIP · fetched every 2 s, not streamed");
  await expect(facts(page).locator('[data-feed-age="trade"]')).toHaveText(/^last trades +\d+ s( +to +\d+ s)? +ago$/);
  await expect(facts(page).locator('[data-feed-age="checked"]')).toHaveText(/^checked +\d+ s ago$/);
  // the scripted answer comes 3 s after its trade (the page's one-second clock can read up to a second short)
  expect(await ageS(page, "newest")).toBeGreaterThanOrEqual(2);
  // both ends read in one look at the page: two looks a tick apart could read the oldest before the newest moved on
  const [oldest, newest] = await facts(page).evaluate((el) =>
    ["oldest", "newest"].map((k) => Number(el.querySelector(`[data-age-end="${k}"]`)?.getAttribute("data-age-s"))),
  );
  expect(oldest ?? NaN).toBeGreaterThanOrEqual(newest ?? NaN);
  expect(await ageS(page, "checked")).toBeLessThanOrEqual(3);
  // the desk's pill names it too
  await expect(page.getByText(/^Live \d{2}:\d{2} · SIP$/).first()).toBeVisible();
  // never read out each second
  expect(await facts(page).getAttribute("aria-live")).toBe("off");
});

test("the same stale trade fetched again: checked stays fresh while the last trade grows, and no row moves", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await sameTradeAgain(page);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(facts(page)).toBeVisible();
  const before = await rowBoxes(page);
  const trade0 = await ageS(page, "newest");
  // past 10 s, so the number gains a digit: the slot keeps its width
  await expect.poll(() => ageS(page, "newest"), { timeout: 20_000 }).toBeGreaterThanOrEqual(Math.max(trade0 + 6, 10));
  expect(await ageS(page, "checked")).toBeLessThanOrEqual(3);
  expect(await rowBoxes(page)).toEqual(before);
  await expect(board(page)).toHaveAttribute("data-board-status", "live");
});

test("an answer that names no feed shows no feed name, only the ages", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await sameTradeAgain(page, (body) => delete body.feed);
  await page.goto("/options");
  await expect(facts(page)).toBeVisible();
  await expect(facts(page).locator("[data-feed-source]")).toHaveText("fetched every 2 s, not streamed");
  await expect(page.locator("[data-feed-name]")).toHaveCount(0);
  await expect(page.getByText(/· (IEX|SIP)$/)).toHaveCount(0);
  await expect(facts(page).locator('[data-age-end="newest"]')).toHaveAttribute("data-age-s", /\d+/);
});

test("while the prices are retried the ages stay in sight, and checked grows", async ({ page, context, baseURL }) => {
  await flaky(context, baseURL);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(retryLine(page)).toBeVisible({ timeout: 10_000 });
  await expect(facts(page)).toBeVisible();
  // under the retry line and all it draws (its button may reach past the header row on a phone), never covered by it
  const drawnTo = await retryLine(page).evaluate((el) => Math.max(el.getBoundingClientRect().bottom, ...[...el.querySelectorAll("*")].map((c) => c.getBoundingClientRect().bottom)));
  const ages = (await facts(page).boundingBox())!;
  expect(ages.y).toBeGreaterThanOrEqual(drawnTo - 1);
  await expect.poll(() => ageS(page, "checked"), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await expect(retryLine(page)).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => ageS(page, "checked"), { timeout: 5_000 }).toBeLessThanOrEqual(2);
});

test("the feed line fits a 375 px screen, keeps its shape as the ages tick, and moves no row", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await at(context, baseURL, 3);
  await sameTradeAgain(page);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  const box = (await facts(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  for (const part of await facts(page).locator(":scope > span").all()) {
    const b = (await part.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    expect(await part.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  }
  const before = await rowBoxes(page);
  const height = box.height;
  await expect.poll(() => ageS(page, "newest"), { timeout: 20_000 }).toBeGreaterThanOrEqual(10);
  expect((await facts(page).boundingBox())!.height).toBe(height);
  expect(await rowBoxes(page)).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("one quiet name is not hidden by a busy one: the line gives both ends, warns by the oldest, and names a name with no trade", async ({ page, context, baseURL }) => {
  await at(context, baseURL, 3);
  await sameTradeAgain(page, (body) => {
    const quotes = body.quotes as Record<string, { at: string }>;
    // QQQ last printed 150 s before the answer (past the 120 s limit); AAPL has no quote at all
    quotes.QQQ!.at = new Date(Date.parse(String(body.as_of)) - 150_000).toISOString();
    delete quotes.AAPL;
  });
  await page.goto("/options");
  await expect(facts(page)).toBeVisible();
  const trade = facts(page).locator('[data-feed-age="trade"]');
  await expect(trade).toHaveAttribute("data-trade-stale", "true");
  await expect(trade.locator("[data-age-range]")).toHaveAttribute("data-age-range", "two");
  await expect(trade).toHaveText(/^last trades +\d+ s +to +\d+ min +ago$/);
  expect(await ageS(page, "newest")).toBeLessThanOrEqual(6);
  // 150 s before the answer; the page's one-second clock can read up to a second short
  expect(await ageS(page, "oldest")).toBeGreaterThanOrEqual(149);
  await expect(trade).toHaveClass(/text-warn/);
  await expect(facts(page).locator("[data-feed-no-trade]")).toHaveText("1 name with no trade today");
});
