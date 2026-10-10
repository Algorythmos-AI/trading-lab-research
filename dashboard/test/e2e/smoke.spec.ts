import { expect, test } from "@playwright/test";

// CI-only smoke test. The server runs with DASHBOARD_FIXTURE=1 (see playwright.config.ts).
const PAGES = [
  { path: "/", heading: "Overview" },
  { path: "/today", heading: "Today" },
  { path: "/radar", heading: "Radar" },
  { path: "/options", heading: "Options" },
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

test("pages carry a nonce CSP and still run their scripts", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (execute|load)/i.test(m.text())) violations.push(m.text());
  });
  await page.emulateMedia({ colorScheme: "light" });
  const res = await page.goto("/");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toContain("'unsafe-inline' 'strict-dynamic'");
  // The inline theme script ran under the nonce: in light mode it removes the server-rendered "dark" class.
  await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
  // React hydrated (Next's own scripts ran): the theme toggle works.
  await page.getByRole("button", { name: /Switch to dark theme/ }).click();
  await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
  expect(violations).toEqual([]);
  // Stray paths render the not-found page: a document, so it carries the policy too.
  for (const path of ["/favicon.ico", "/robots.txt-nope", "/icon-x"]) {
    const r = await page.request.get(path);
    expect(r.headers()["content-security-policy"] ?? "", path).toContain("'strict-dynamic'");
  }
});

test("the options page shows the glance strip, the rules and a level map per name", async ({ page }) => {
  await page.goto("/options");
  await expect(page.getByText("Levels for Mon 12 Oct")).toBeVisible();
  const glance = page.getByRole("list", { name: "Every name against its nearest zones" });
  await expect(glance.getByRole("link", { name: "SPY", exact: true })).toBeVisible();
  await expect(page.getByText("No rule is proven yet", { exact: false })).toBeVisible();
  await expect(page.getByRole("img", { name: /^SPY: last 40 daily bars/ })).toBeVisible();
  // The strip polls /api/quote; fixture mode answers with SPY 0.3 ATR above its close at 11:00 New York on the
  // fixture's session, inside the major resistance zone.
  await expect(glance.getByRole("listitem").filter({ hasText: "SPY" })).toContainText("TESTING RESISTANCE");
  // The same quote moves the live dot on SPY's level map.
  await expect(page.getByTestId("SPY-live-mark")).toBeAttached();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("options focus mode keeps the strip and the maps and hides the rest", async ({ page }) => {
  await page.goto("/options");
  const rules = page.getByRole("heading", { name: "Entry rules" });
  await expect(rules).toBeVisible();
  await page.getByRole("button", { name: "Focus mode" }).click();
  await expect(rules).toBeHidden();
  await expect(page.getByRole("list", { name: "Every name against its nearest zones" })).toBeVisible();
  await expect(page.getByRole("img", { name: /^SPY: last 40 daily bars/ })).toBeVisible();
  // Remembered on reload, and one click brings everything back.
  await page.reload();
  await expect(rules).toBeHidden();
  await page.getByRole("button", { name: "Show everything" }).click();
  await expect(rules).toBeVisible();
});

test("a live quote older than 30 seconds reads as stale", async ({ page }) => {
  // Fixture quotes are SPY's last trade at 11:00 New York on the fixture's session; a minute later it is stale.
  await page.clock.setFixedTime(new Date("2026-10-12T15:01:00Z"));
  await page.goto("/options");
  const spy = page.getByRole("list", { name: "Every name against its nearest zones" }).getByRole("listitem").filter({ hasText: "SPY" });
  await expect(spy).toContainText("STALE");
});

test("the radar draws the scorecard, the picks, the lines and the week", async ({ page }) => {
  await page.goto("/radar");
  await expect(page.getByRole("img", { name: "Market regime: neutral" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Market gauges" })).toContainText("VIX");
  await expect(page.getByRole("img", { name: /^Each list's average move on .* against its benchmark\. SUPPORT PLAYS/ })).toBeVisible();
  const picks = page.getByRole("list", { name: "Daily radar picks" });
  await expect(picks.getByRole("img", { name: /^AMZN: price 253\.71, support 244\.30/ })).toBeVisible();
  await expect(picks).toContainText("strong");
  await expect(page.getByRole("img", { name: /^Support plays: percent above support\. GOOGL 3\.2%/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Catalysts this week" })).toContainText("PCE inflation");
  // The tables are one click away.
  await page.getByText("Every list as a table").click();
  await expect(page.getByRole("heading", { name: "SUPPORT PLAYS", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the v3 panels render from the fixture, and the glossary is linked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/risk");
  await expect(page.getByRole("heading", { name: "Limits in force" })).toBeVisible();
  await expect(page.getByText("Daily loss latch").first()).toBeVisible();
  await page.goto("/operations");
  await expect(page.getByRole("heading", { name: "Job reliability, 14 days" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible();
  await page.goto("/strategies");
  await expect(page.getByRole("heading", { name: "Paper B performance" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Since the last trading day" })).toBeVisible();
  await page.getByRole("link", { name: "Glossary" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Glossary" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

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

// ---- the crypto desk (ADR 0005) ------------------------------------------------------------------------------------

const CRYPTO_PAGES = [
  { path: "/crypto", heading: "Overview" },
  { path: "/crypto/market", heading: "Market" },
  { path: "/crypto/strategy", heading: "Strategy" },
  { path: "/crypto/research", heading: "Research" },
  { path: "/crypto/learning", heading: "Machine learning" },
  { path: "/crypto/operations", heading: "Operations" },
  { path: "/crypto/risk", heading: "Risk" },
];

for (const { path, heading } of CRYPTO_PAGES) {
  test(`crypto ${heading} page renders`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);

    const nav = page.getByRole("navigation", { name: "Sections" });
    for (const p of CRYPTO_PAGES) {
      await expect(nav.getByRole("link", { name: p.heading, exact: true })).toHaveAttribute("href", p.path);
    }
    await expect(nav.getByRole("link", { name: heading, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeAttached();
    // the desk switch says where we are, and the header shows the crypto desk's clock
    const desk = page.getByRole("navigation", { name: "Desk" });
    await expect(desk.getByRole("link", { name: "Crypto" })).toHaveAttribute("aria-current", "true");
    await expect(desk.getByRole("link", { name: "Stocks" })).not.toHaveAttribute("aria-current", "true");
    await expect(page.getByText("24/7")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("the desk switch moves between the two desks, each with its own sections", async ({ page }) => {
  await page.goto("/");
  const desk = page.getByRole("navigation", { name: "Desk" });
  await expect(desk.getByRole("link", { name: "Stocks" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByText("24/7")).toHaveCount(0);
  await desk.getByRole("link", { name: "Crypto" }).click();
  await expect(page).toHaveURL(/\/crypto$/);
  await expect(page.getByRole("heading", { name: "Latest bar, per pair" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "BTC/USD" }).first()).toBeVisible();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Research", exact: true }).click();
  await expect(page).toHaveURL(/\/crypto\/research$/);
  await expect(page.getByRole("heading", { name: "Gate C0: data quality" })).toBeVisible();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Strategy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What a trade is worth after costs" })).toBeVisible();
  await page.getByRole("navigation", { name: "Desk" }).getByRole("link", { name: "Stocks" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Strategies", exact: true })).toBeAttached();
});
