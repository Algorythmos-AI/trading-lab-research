import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

// CI-only. "Done for today" on the rail. The fixture server keeps the flag in one place shared by every test running
// at once, so these tests never touch it: each one answers /api/desk/flags itself, in its own browser, and the page
// cannot tell the difference.

async function at(context: BrowserContext, baseURL: string | undefined, flags = "focus.quotes-script", step = 3) {
  await context.addCookies([
    { name: "fx", value: flags, url: baseURL! },
    { name: "fxstep", value: String(step), url: baseURL! },
  ]);
}

const NOT_DONE = { done: false, day: null, at: null, canUndo: false, undoLeftS: 0, memory: false };
const doneNow = (undoLeftS = 60) => ({ done: true, day: "2026-10-12", at: new Date().toISOString(), canUndo: undoLeftS > 0, undoLeftS, memory: false });

/** Answers the flag's route in this browser: a read gives the current view, a write sets it (or fails when asked). */
async function fakeFlags(page: Page, o: { readFails?: boolean; writeFails?: boolean } = {}) {
  let view: object = NOT_DONE;
  await page.route("**/api/desk/flags", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") {
      if (o.readFails) return route.fulfill({ status: 503, json: { error: "read-failed" } });
      return route.fulfill({ json: view });
    }
    if (o.writeFails) return route.fulfill({ status: 503, json: { error: "write-failed" } });
    const { action } = req.postDataJSON() as { action: "done" | "undo" };
    // as the real route: a second "done" keeps the first mark and its window
    if (action === "done") view = (view as { done: boolean }).done ? view : doneNow();
    else view = NOT_DONE;
    return route.fulfill({ json: view });
  });
}

const control = (page: Page) => page.locator("[data-done-control]:visible");
const rows = (page: Page) => page.locator("[data-trade-now] [data-board-row]");

test("an open day: the outline button asks, says what keeps working, then shows a blue pill with an Undo countdown", async ({ page, context, baseURL, isMobile }) => {
  await at(context, baseURL);
  await fakeFlags(page);
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(control(page)).toHaveAttribute("data-done-state", "open");
  await control(page).locator("[data-done-button]").click();
  const box = control(page).locator("[data-done-confirm]");
  await expect(box).toContainText("Entry prompts will be hidden on both devices");
  await expect(box.locator("[data-done-keeps]")).toContainText("stops, exits and the manage cards keep working");
  await box.locator("[data-done-confirm-yes]").click();
  const pill = page.locator("[data-rail-done]");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("data-tone", "info");
  // the Undo shows how long is left, and counts down
  const left = control(page).locator("[data-undo-left]");
  await expect(left).toHaveText(/^(60|59|58) s$/);
  const first = Number((await left.innerText()).replace(" s", ""));
  await page.waitForTimeout(2_200);
  expect(Number((await left.innerText()).replace(" s", ""))).toBeLessThan(first);
  await control(page).locator("[data-done-undo]").click();
  await expect(pill).toHaveCount(0);
  if (!isMobile) await expect(control(page).locator("[data-done-button]")).toBeFocused();
});

test("a save that fails says so in red, and the day stays open", async ({ page, context, baseURL }) => {
  await at(context, baseURL);
  await fakeFlags(page, { writeFails: true });
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await control(page).locator("[data-done-button]").click();
  await control(page).locator("[data-done-confirm-yes]").click();
  await expect(control(page).locator("[data-done-failed]").first()).toContainText("Did not save");
  await expect(control(page)).toHaveAttribute("data-done-state", "failed");
  await expect(page.locator("[data-rail-done]")).toHaveCount(0);
});

test("a flag that cannot be read is amber and says so, never that the day is open", async ({ page, context, baseURL }) => {
  await at(context, baseURL);
  await fakeFlags(page, { readFails: true });
  await page.goto("/options");
  await expect(rows(page).first()).toHaveAttribute("data-board-state", "enter_zone");
  await expect(control(page)).toHaveAttribute("data-done-state", "unchecked");
});

test("with the day over the button turns amber and asks, without setting anything", async ({ page, context, baseURL, isMobile }) => {
  // one contract bought at $17.00 whose bid is $12.11: the open loss is past the day's $100, so the day pill is red
  await at(context, baseURL, "frozen.focus.quotes-script.chain-opra.journal-option-stop", 3);
  await fakeFlags(page);
  await page.goto("/options");
  await expect(page.locator("[data-rail-day]")).toHaveAttribute("data-rail-day", "bad", { timeout: 15_000 });
  await expect(control(page)).toHaveAttribute("data-done-state", "limit");
  if (!isMobile) await expect(control(page).locator("[data-done-button]")).toContainText("Day over: mark done?");
  await expect(page.locator("[data-rail-done]")).toHaveCount(0);
});
