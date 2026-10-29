import { expect, test } from "@playwright/test";
import { scan, useTheme } from "./axe";

// Card record (/options/record): how the Top 4 Focus Card did, from the synthetic ledger fixture.

for (const theme of ["light", "dark"] as const) {
  test(`card record renders the day and the record, ${theme}`, async ({ page, context }) => {
    await useTheme(context, theme);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto("/options/record");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Card record" })).toBeVisible();
    await expect(page.getByText("How the card did · Wed 28 Oct")).toBeVisible();
    await expect(page.getByTestId("ledger-name")).toHaveCount(4);
    await expect(page.getByText("Lesson of the day:")).toBeVisible();
    await expect(page.getByText("How much each number can be trusted")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await scan(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("a session with no scored card says so", async ({ page }) => {
  const res = await page.goto("/options/record?d=2026-10-27");
  expect(res?.status()).toBe(200);
  await expect(page.getByText("No scored card for Tue 27 Oct.")).toBeVisible();
});

test("health reports the ledger edition", async ({ request }) => {
  const body = await (await request.get("/api/health")).json();
  expect(body.editions.ledger).toMatchObject({ status: "ok", accepts: 1, session: "2026-10-28" });
});

test("Today links to the last scored card", async ({ page }) => {
  await page.goto("/today");
  const line = page.getByTestId("ledger-line");
  await expect(line).toContainText("Card scored · Wed 28 Oct");
  await expect(line).toHaveAttribute("href", "/options/record?d=2026-10-28#card-review");
});

test("Options leaves the screen to the desk when the scored card is not the day before its levels", async ({ page }) => {
  // The fixture's levels are for 12 Oct and its scored card is 28 Oct, so the desk page shows no review.
  await page.goto("/options");
  await expect(page.locator("#card-review")).toHaveCount(0);
});
