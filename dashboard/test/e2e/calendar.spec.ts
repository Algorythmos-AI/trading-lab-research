import { expect, test, type BrowserContext } from "@playwright/test";

// CI-only. The Calendar page in fixture mode, at the frozen instant (11:01 New York, Monday 12 October 2026), so
// every count on it is fixed. The journal fixture's trades close between April and mid-October 2026.

async function variant(context: BrowserContext, baseURL: string | undefined, fx: string) {
  await context.addCookies([{ name: "fx", value: fx, url: baseURL! }]);
}

test("counts down from today and names what is next", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "frozen");
  await page.goto("/calendar");
  const tiles = page.locator(".tile");
  // 12 October to 31 December 2026: 15 sessions in October, 20 in November, 22 in December.
  await expect(tiles.nth(0)).toContainText("57");
  await expect(tiles.nth(1)).toContainText("Thanksgiving Day");
  await expect(tiles.nth(2)).toContainText("Day after Thanksgiving");
  // Sydney went forward on 4 October; New York goes back on 1 November, so Monday 2 November opens at 01:30.
  await expect(tiles.nth(3)).toContainText("New York clocks go back: the open moves from 00:30 to 01:30 Sydney");
});

test("today is open, and a tapped day shows its hours, result and events", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "frozen");
  await page.goto("/calendar");
  const detail = page.getByTestId("day-detail");
  await expect(detail).toHaveCount(1);
  await expect(detail).toContainText("Monday 12 October 2026");
  await expect(detail).toContainText("Sydney Tue 00:30");

  await page.getByRole("button", { name: /^Fri 27 Nov 2026\. Day after Thanksgiving, closes 1 pm New York/ }).click();
  await expect(detail).toContainText("Friday 27 November 2026");
  await expect(detail).toContainText("Sydney Sat 01:30 → Sat 05:00");

  const traded = page.getByRole("button", { name: /^\w{3} \d+ \w{3} 2026\. .*trades?/ }).first();
  await traded.click();
  await expect(detail).toContainText("Trades");
  await expect(detail).toContainText("Day rules");

  await page.getByRole("button", { name: /^Thu 26 Nov 2026\. market closed, Thanksgiving Day/ }).click();
  await expect(detail).toContainText("Market closed · Thanksgiving Day");
});

test("2027 is one tap away and carries no results yet", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "frozen");
  await page.goto("/calendar");
  await page.getByRole("navigation", { name: "Year" }).getByRole("link", { name: "2027" }).click();
  await expect(page).toHaveURL(/\?y=2027/);
  await expect(page.getByRole("link", { name: "2027" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("2027 · 251 market days")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Fri 24 Dec 2027\. market closed, Christmas Day \(observed\)/ })).toBeVisible();
  await expect(page.getByTestId("not-listed")).toContainText("CPI");
  // A year (and a month) that has not begun shows its market days only, not "0 traded".
  await expect(page.getByText("2027 · 251 market days")).not.toContainText("traded");
  await expect(page.locator("#m-2027-01")).not.toContainText("traded");
});

test("every event group in the key has its colour", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "frozen");
  await page.goto("/calendar");
  const key = page.getByRole("list", { name: "Key" });
  for (const label of ["Fed", "Inflation (CPI, PPI, PCE)", "Jobs, GDP, retail sales", "Monthly expiry", "Earnings"]) {
    const dot = key.getByRole("listitem").filter({ hasText: label }).locator("span[aria-hidden]");
    const bg = await dot.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(bg, label).not.toBe("rgba(0, 0, 0, 0)");
  }
});

test("a bad year in the address falls back to this year", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "frozen");
  await page.goto("/calendar?y=1999");
  await expect(page.getByRole("link", { name: "2026" })).toHaveAttribute("aria-current", "page");
});

for (const fx of ["empty", "error", "journal-poison"]) {
  test(`with the journal ${fx}, the market calendar still draws`, async ({ page, context, baseURL }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await variant(context, baseURL, `frozen.${fx}`);
    await page.goto("/calendar");
    await expect(page.getByRole("button", { name: /^Thu 26 Nov 2026\. market closed, Thanksgiving Day/ })).toBeVisible();
    await expect(page.locator(".tile").nth(0)).toContainText("57");
    await expect(page.getByText(/the days below show the market only, without your results/)).toBeVisible();
    await expect(page.getByText("This page could not be drawn")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("an official release shows its source and its cross-check", async ({ page, context, baseURL }) => {
  await variant(context, baseURL, "frozen");
  await page.goto("/calendar");
  await page.getByRole("button", { name: /^Tue 10 Nov 2026\. CPI inflation/ }).click();
  const detail = page.getByTestId("day-detail");
  await expect(detail).toContainText("CPI inflation");
  await expect(detail).toContainText("08:30 NY · Wed 00:30 Syd");
  await expect(detail).toContainText("FRED, checked by BLS");
  await page.getByRole("navigation", { name: "Year" }).getByRole("link", { name: "2027" }).click();
  await expect(page.getByTestId("not-listed")).toContainText(/Not yet announced for all of 2027: CPI, PPI, Jobs report/);
});

for (const [fx, text] of [
  ["calendar-off", "has not been published yet"],
  ["calendar-poison", "could not be read"],
  ["calendar-stale", "last refreshed 21 days ago"],
] as const) {
  test(`with the economic calendar ${fx.replace("calendar-", "")}, the page says so and still draws`, async ({ page, context, baseURL }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await variant(context, baseURL, `frozen.${fx}`);
    await page.goto("/calendar");
    await expect(page.getByTestId("release-notes")).toContainText(text);
    await expect(page.getByRole("button", { name: /^Thu 26 Nov 2026\. market closed, Thanksgiving Day/ })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
