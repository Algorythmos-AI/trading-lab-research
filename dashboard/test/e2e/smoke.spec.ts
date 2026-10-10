import { expect, test } from "@playwright/test";
import { scan, useTheme } from "./axe";

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

// The page as it was before the desk stays at ?view=classic for one release; these three tests keep it honest.
test("the classic options page shows the glance strip, the rules and a level map per name", async ({ page }) => {
  await page.goto("/options?view=classic");
  await expect(page.getByText("Levels for Mon 12 Oct")).toBeVisible();
  const glance = page.getByRole("list", { name: "Every name against its nearest zones" });
  await expect(glance.getByRole("link", { name: "SPY", exact: true })).toBeVisible();
  await expect(page.getByText("No rule is proven yet", { exact: false })).toBeVisible();
  await expect(page.getByRole("img", { name: /^SPY: last 40 daily bars/ })).toBeVisible();
  // The strip polls /api/quote; fixture mode answers with SPY 0.3 ATR above its close at 11:00 New York on the
  // fixture's session, inside the major resistance zone.
  await expect(glance.getByRole("listitem").filter({ hasText: "SPY" })).toContainText("TESTING RESISTANCE");
  // Close strength vs option price: NVDA is the weak close with cheap options.
  await expect(page.getByRole("img", { name: /^Close strength against IV percentile for 10 names/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Names in each corner" })).toContainText("NVDA");
  // The same quote moves the live dot on SPY's level map.
  await expect(page.getByTestId("SPY-live-mark")).toBeAttached();
  // Findings with no registered experiment say so, the scorecard says what its R measures, and nothing on the
  // page suggests a spread (the owner trades single calls and puts).
  await expect(page.getByText("Exploratory", { exact: true })).toHaveCount(3);
  await expect(page.getByText("R is measured on the stock", { exact: false })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/spread|selling premium/i);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("classic options focus mode keeps the strip and the maps and hides the rest", async ({ page }) => {
  await page.goto("/options?view=classic");
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
  await page.goto("/options?view=classic");
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

test("today draws the session clock and the open paper position", async ({ page }) => {
  // 11:02 New York on the fixture's trading day, so the clock shows "now".
  await page.clock.setFixedTime(new Date("2026-09-29T15:02:00Z"));
  await page.goto("/today");
  const clock = page.getByRole("img", { name: /^The New York day 2026-09-29 from 04:00 to 20:00/ });
  await expect(clock).toBeVisible();
  // Every lane ends in a word, never colour alone: the fixture's routine run failed.
  await expect(page.getByTestId("clock-routine")).toContainText("failed");
  await expect(page.getByTestId("clock-paper-b")).toContainText("ok");
  await expect(page.getByTestId("clock-now")).toContainText("now 11:02");
  // The fixture holds QQQM; there is no live quote for it, so the bar uses the paper account's mark.
  await expect(page.getByRole("img", { name: /^QQQM paper position: stop 199\.00, entry 200\.02, target 202\.00, price 204\.13/ })).toBeVisible();
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
  expect(await res.json()).toMatchObject({
    ok: true,
    fixture: true,
    snapshot_as_of: expect.any(String),
    // The research editions on file and the newest format of each this build accepts.
    editions: {
      options: { status: "ok", accepts: 2, session: "2026-10-12", run_id: expect.any(String) },
      radar: { status: "ok", accepts: 1, edition_date: expect.any(String) },
    },
  });
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
  { path: "/crypto/engineering", heading: "Engineering" },
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

test("each desk has its own Engineering wiki, and both show the shared Lab platform", async ({ page }) => {
  for (const [path, first] of [
    ["/engineering", "Plans and history"],
    ["/crypto/engineering", "The desk's jobs"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2, name: "Lab platform" })).toBeVisible();
    await expect(page.getByRole("heading", { name: first, exact: true })).toBeAttached();
    for (const name of ["How a change ships", "Recent check runs", "What leaves the host", "The trading host"]) {
      await expect(page.getByRole("heading", { name, exact: true })).toBeAttached();
    }
    await expect(page.getByRole("img", { name: /^How a change ships\./ })).toBeAttached();
    await expect(page.getByRole("img", { name: /^Recent check runs: security/ })).toBeAttached();
  }
  // The crypto wiki lists the desk's jobs from the crypto snapshot.
  await expect(page.getByRole("list", { name: "The crypto desk's jobs and their last runs" })).toContainText("Bar cycle");
});

test("the stocks wiki draws the desk from the snapshot", async ({ page }) => {
  await page.goto("/engineering");
  for (const name of ["At a glance", "Architecture", "A trading night", "Order safety", "Research gates", "Runbooks and decisions"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeAttached();
  }
  // The fixture's kill switch is on and its routine's last run failed: the glance and the guard say so.
  const glance = page.getByRole("list", { name: "The stocks desk at a glance" });
  await expect(glance).toContainText("Kill switch on");
  await expect(glance).toContainText("needs a look: routine");
  await expect(page.getByRole("img", { name: /^Architecture of the stocks desk\..*routine \(last run failed\)/ })).toBeAttached();
  await expect(page.getByRole("img", { name: /^Order safety\..*Kill switch on/ })).toBeAttached();
  await expect(page.getByRole("img", { name: /^Research gates: K0 .* G1 .*failed/ })).toBeAttached();
});

test("the crypto wiki draws the desk from the crypto snapshot", async ({ page }) => {
  await page.goto("/crypto/engineering");
  const sections = ["At a glance", "Architecture", "The bar cycle", "Around the clock", "Risk limits", "The learning loop"];
  sections.push("Challengers and gates", "The data harvest");
  for (const name of [...sections, "Owner controls"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeAttached();
  }
  // The fixture's crypto kill switch is on, 95 of 96 cycles ran, and the model lineage in force is in shadow.
  const glance = page.getByRole("list", { name: "The crypto desk at a glance" });
  await expect(glance).toContainText("Kill switch on");
  await expect(glance).toContainText("95 of 96");
  await expect(page.getByRole("img", { name: /^Architecture of the crypto desk\..*5 paper books \(baseline, trend, break, dip, ch-29db21a0\)/ })).toBeAttached();
  await expect(page.getByRole("img", { name: /^The learning loop: .*The lineage in force is shadow, with 74 finished signals/ })).toBeAttached();
  await expect(page.getByRole("img", { name: /^A UTC day of 96 bar cycles\./ })).toBeAttached();
  // The harvest books come from the snapshot's own harvest block.
  await expect(page.getByRole("img", { name: /^The data harvest \(switch on, DEC-0027\): books h-trend, .*h-explore/ })).toBeAttached();
  await expect(page.getByRole("list", { name: "The data harvest in numbers" })).toContainText("107");
});

// ---- the HFT desk (ADR 0006) ----------------------------------------------------------------------------------------

const DESK_LINKS = [
  { name: "Stocks", href: "/" },
  { name: "Crypto", href: "/crypto" },
  { name: "HFT", href: "/hft" },
];

test("the desk switch has three desks and says which one a page belongs to", async ({ page }) => {
  for (const [path, current] of [
    ["/", "Stocks"],
    ["/options", "Stocks"],
    ["/crypto", "Crypto"],
    ["/crypto/risk", "Crypto"],
    ["/hft", "HFT"],
  ] as const) {
    await page.goto(path);
    const desk = page.getByRole("navigation", { name: "Desk" });
    await expect(desk.getByRole("link")).toHaveText(DESK_LINKS.map((d) => d.name));
    for (const d of DESK_LINKS) {
      const link = desk.getByRole("link", { name: d.name, exact: true });
      await expect(link).toHaveAttribute("href", d.href);
      if (d.name === current) await expect(link).toHaveAttribute("aria-current", "true");
      else await expect(link).not.toHaveAttribute("aria-current", "true");
    }
    await expect(desk.locator('[aria-current="true"]')).toHaveCount(1);
  }
});

test("the HFT page renders from the fixture", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.goto("/hft");
  expect(res?.status()).toBe(200);

  // one section for now, and the header shows the HFT desk's hours
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav.getByRole("link")).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("href", "/hft");
  await expect(nav.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("24/5")).toBeVisible();
  await expect(page.getByText("24/7")).toHaveCount(0);

  await expect(page.getByRole("heading", { level: 1, name: "HFT" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator("#health-title")).toBeVisible();
  for (const name of ["Build phases", "Recorder", "Pairs", "Sleeves", "Books", "Learning"]) {
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  }
  const status = page.getByRole("region", { name: "Desk status" });
  for (const words of ["Paper", "Shadow", "IBKR paper", "Open", "Off"]) await expect(status).toContainText(words);
  await expect(page.getByRole("list", { name: "Build phases in order" }).getByRole("listitem")).toHaveCount(8);
  await expect(page.getByRole("list", { name: "Build phases in order" }).getByRole("listitem").filter({ hasText: "F3" })).toContainText("Now");
  const pairs = page.getByRole("region", { name: "Currency pairs" });
  await expect(pairs.getByRole("columnheader")).toHaveText(["Pair", "Form", "Last quote", "Updates a second", "Median spread"]);
  await expect(pairs.getByRole("cell", { name: "EUR.USD" })).toBeVisible();
  const sleeves = page.getByRole("region", { name: "Sleeves" });
  await expect(sleeves.getByRole("row")).toHaveCount(3);
  await expect(sleeves.getByRole("row").nth(2)).toContainText("Directional change");
  await expect(page.getByRole("heading", { level: 3, name: "Shadow book" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Broker book" })).toBeVisible();
  await expect(page.getByText("The shadow book is the result of record.")).toBeVisible();
  await expect(page.getByText("dc_2026w39.r1")).toBeVisible();
  // a table's scroll area can be reached with the keyboard
  await pairs.focus();
  await expect(pairs).toBeFocused();
  // the footer names the HFT snapshot, which has no redaction level
  await expect(page.locator("footer")).toContainText("Snapshot 20261009T143000Z-fixture, schema v1.");
  await expect(page.locator("footer")).not.toContainText("redaction");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the HFT page is a composed empty state while the desk has not published", async ({ page, context, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.addCookies([{ name: "fx", value: "empty", url: baseURL! }]);
  const res = await page.goto("/hft");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "HFT" })).toBeVisible();
  await expect(page.getByText("The HFT desk has not published yet")).toBeVisible();
  await expect(page.getByText("This page fills in when the desk's recorder starts", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "What this page will show" })).toBeVisible();
  // nothing that looks like a reading: no banner, no table, no badge, and not one digit beyond the phases' names
  const main = page.locator("main");
  await expect(main.locator("#health-title")).toHaveCount(0);
  await expect(main.locator("table")).toHaveCount(0);
  await expect(main.locator('[data-slot="badge"]')).toHaveCount(0);
  expect(((await main.innerText()) ?? "").replace("F0 to F7", "")).not.toMatch(/\d|—/);
  // the header says there is no data, and the footer names no snapshot
  await expect(page.getByRole("banner").getByRole("status")).toHaveText("No data yet");
  await expect(page.locator("footer")).not.toContainText("Snapshot");
  await expect(page.getByRole("navigation", { name: "Desk" }).getByRole("link", { name: "HFT" })).toHaveAttribute("aria-current", "true");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the HFT page says so when its storage cannot be read", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "error", url: baseURL! }]);
  await page.goto("/hft");
  await expect(page.getByRole("heading", { level: 1, name: "HFT" })).toBeVisible();
  await expect(page.getByText("Storage could not be read")).toBeVisible();
  await expect(page.locator("main table")).toHaveCount(0);
});

test("the desk switch reaches the HFT desk and comes back", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Desk" }).getByRole("link", { name: "HFT" }).click();
  await expect(page).toHaveURL(/\/hft$/);
  await expect(page.getByRole("heading", { level: 1, name: "HFT" })).toBeVisible();
  await page.getByRole("navigation", { name: "Desk" }).getByRole("link", { name: "Crypto" }).click();
  await expect(page).toHaveURL(/\/crypto$/);
  await expect(page.getByText("24/7")).toBeVisible();
  await page.getByRole("navigation", { name: "Desk" }).getByRole("link", { name: "Stocks" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Strategies", exact: true })).toBeAttached();
});

test("health reports the HFT desk beside the crypto desk", async ({ request }) => {
  const body = await (await request.get("/api/health")).json();
  expect(body.desks).toEqual({
    crypto: { snapshot: "ok", as_of: expect.any(String), run_id: expect.any(String) },
    hft: { snapshot: "ok", as_of: "2026-10-09T14:30:00+00:00", run_id: "20261009T143000Z-fixture" },
  });
});

/** Where the header's parts sit. Rounded: only rows and edges matter here. */
async function headerBoxes(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const box = (el: Element | null | undefined) => {
      const b = el?.getBoundingClientRect();
      return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) } : null;
    };
    const header = document.querySelector("header");
    const desk = header?.querySelector('nav[aria-label="Desk"]');
    return {
      width: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      position: header ? getComputedStyle(header).position : null,
      header: box(header),
      desk: box(desk),
      links: [...(desk?.querySelectorAll("a") ?? [])].map(box),
      pill: box(header?.querySelector('[role="status"]')),
      clocks: box(header?.querySelector('[aria-label="Local clocks"]')),
      sections: box(header?.querySelector('nav[aria-label="Sections"]')),
    };
  });
}

const EVERY_DESK = ["/", "/options", "/crypto", "/hft"];

test("on a phone the three desks stay on one line, nothing scrolls sideways, and the header does not stick", async ({ page, isMobile }) => {
  test.skip(isMobile, "sets its own phone widths");
  for (const width of [360, 375, 412]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of EVERY_DESK) {
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "Desk" }).getByRole("link")).toHaveCount(3);
      const h = await headerBoxes(page);
      const at = `${path} at ${width}px`;
      expect(h.overflow, at).toBeLessThanOrEqual(0);
      expect(new Set(h.links.map((l) => l?.top)).size, at).toBe(1);
      expect(h.desk!.left, at).toBeGreaterThanOrEqual(0);
      expect(h.desk!.right, at).toBeLessThanOrEqual(h.width);
      expect(h.pill!.right, at).toBeLessThanOrEqual(h.width);
      // The Options desk pins its own bars to the top and bottom of a phone screen, so the site header must scroll away.
      expect(h.position, at).toBe("static");
    }
  }
});

test("on a laptop the third desk leaves the header one row above the sections, on every desk", async ({ page, isMobile }) => {
  test.skip(isMobile, "sets its own laptop widths");
  for (const width of [1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const heights = new Set<number>();
    for (const path of EVERY_DESK) {
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "Desk" }).getByRole("link")).toHaveCount(3);
      const h = await headerBoxes(page);
      const at = `${path} at ${width}px`;
      // the switch, the pill and the clocks share one row, and the sections come straight after it
      expect(h.pill!.top, at).toBeLessThan(h.desk!.bottom);
      expect(h.pill!.bottom, at).toBeGreaterThan(h.desk!.top);
      expect(h.clocks!.top, at).toBeLessThan(h.desk!.bottom);
      expect(h.clocks!.bottom, at).toBeGreaterThan(h.desk!.top);
      expect(h.sections!.top, at).toBeGreaterThanOrEqual(h.desk!.bottom);
      expect(h.position, at).toBe("sticky");
      expect(h.overflow, at).toBeLessThanOrEqual(0);
      heights.add(h.header!.bottom - h.header!.top);
    }
    // The Options desk is sized from this height (xl:h-[calc(100dvh-10.5rem)]): it is the same on every desk's pages.
    expect([...heights], `header height at ${width}px`).toHaveLength(1);
  }
});

// The same scan a11y.spec.ts runs on the stocks pages (WCAG 2.1 A and AA, nothing waived, both themes), on the desktop
// project and on the phone project: the page's tables scroll inside an area the keyboard can reach.
for (const theme of ["light", "dark"] as const) {
  for (const [fx, state] of [
    [null, "from the fixture"],
    ["empty", "before the desk has published"],
  ] as const) {
    test(`/hft ${state} passes the accessibility scan in ${theme}`, async ({ page, context, baseURL }) => {
      await useTheme(context, theme);
      if (fx) await context.addCookies([{ name: "fx", value: fx, url: baseURL! }]);
      await page.goto("/hft");
      await expect(page.getByRole("heading", { level: 1, name: "HFT" })).toBeAttached();
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      expect(await scan(page)).toEqual([]);
    });
  }
}
