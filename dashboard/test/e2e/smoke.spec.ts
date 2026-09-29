import { expect, test } from "@playwright/test";

// CI-only smoke test. The server runs with DASHBOARD_FIXTURE=1 (see playwright.config.ts).
const PAGES = [
  { path: "/", heading: "Overview" },
  { path: "/strategies", heading: "Strategies" },
  { path: "/research", heading: "Research" },
  { path: "/operations", heading: "Operations" },
  { path: "/risk", heading: "Risk" },
  { path: "/engineering", heading: "Engineering" },
];

for (const { path, heading } of PAGES) {
  test(`${heading} page renders`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const res = await page.goto(path);
    expect(res?.status()).toBe(200);

    const nav = page.getByRole("navigation", { name: "Sections" });
    await expect(nav).toBeVisible();
    for (const p of PAGES) {
      await expect(nav.getByRole("link", { name: p.heading, exact: true })).toBeAttached();
    }
    await expect(nav.getByRole("link", { name: heading, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeAttached();
    await expect(page.getByText("Fixture data (DASHBOARD_FIXTURE=1)")).toBeVisible();

    // Mobile-first: the page itself never scrolls sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("health endpoint answers without secrets", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ ok: true, fixture: true, snapshot_as_of: expect.any(String) });
});

test("ingest refuses writes outside production", async ({ request }) => {
  const res = await request.post("/api/ingest", { data: "{}" });
  expect(res.status()).toBe(403);
});

test("the watchdog requires the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/watchdog");
  expect(res.status()).toBe(401);
});
