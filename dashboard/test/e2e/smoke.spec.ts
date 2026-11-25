import { expect, test } from "@playwright/test";
import { scan, useTheme } from "./axe";

// CI-only smoke test. The server runs with DASHBOARD_FIXTURE=1 (see playwright.config.ts).
const PAGES = [
  { path: "/", heading: "Overview" },
  { path: "/today", heading: "Today" },
  { path: "/radar", heading: "Radar" },
  { path: "/options", heading: "Options" },
  { path: "/paper", heading: "Paper" },
  { path: "/gap-hunter", heading: "Gap Hunter" },
  { path: "/calendar", heading: "Calendar" },
  { path: "/strategies", heading: "Strategies" },
  { path: "/research", heading: "Research" },
  { path: "/research/records", heading: "Records" },
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
  // The testing pane quotes EXP-0023; the one finding without a registered experiment (the edition's expected-move
  // check) says so. The scorecard says what its R measures, and nothing on the page suggests a spread (the owner
  // trades single calls and puts).
  await expect(page.getByText(/^EXP-0023 replicated the four level entry rules/)).toBeVisible();
  await expect(page.getByText("Exploratory", { exact: true })).toHaveCount(1);
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

test("the radar leads with the brief: the day, SPY's open, the session, your names, the week", async ({ page }) => {
  await page.goto("/radar");
  // The pipeline card leads: where the session's edition stands, the seven stages of the morning's run, the last
  // twenty sessions, the Radar's and the desk's counts, and the cloud jobs behind it. The fixture is a clean run so far at whatever
  // time this runs, so the badge is never a late or a failed one.
  await expect(page.getByRole("status", { name: /^Radar pipeline: (On time|Building now|Waiting for the edition|Not due yet|No session today)$/ })).toBeVisible();
  await expect(page.getByRole("list", { name: /^The Radar pipeline for / }).getByRole("listitem")).toHaveCount(7);
  await expect(page.getByRole("img", { name: /^The last 20 sessions, oldest first: / })).toBeVisible();
  // The Radar's count and the desk's pick are two separate facts, never one funnel.
  const counts = page.getByRole("list", { name: "Two separate counts" });
  await expect(counts.getByRole("listitem")).toHaveCount(2);
  await expect(counts).toContainText(/Radar scanned (\d+|—)morning of /);
  await expect(counts).toContainText(/Desk (\d+|—) → (\d+|—) picked/);
  const jobs = page.getByRole("list", { name: "The cloud jobs behind the Radar, in order" });
  await expect(jobs.getByRole("listitem")).toHaveCount(4);
  await expect(jobs).toContainText("Radar build");
  for (const id of ["trig_01PW2UvCBejb4UxCEB58PEVp", "trig_015qsK3nrRQgscNZh6strL4F", "trig_01B1TN3d4x7dZ3Wxad2LmYgb", "trig_01WyzH7k8xAUgj8RZsakUDW7"]) await expect(jobs).toContainText(id);
  await expect(page.getByRole("group", { name: /^The day: ((Normal|Careful|Event) day|Not fully checked)$/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /^SPY close 778\.55, expected move ±5\.85\. Levels: PML 749\.60/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /^The New York session on 2026-09-21: no entries 09:30 to 09:35/ })).toBeVisible();
  const names = page.getByRole("list", { name: "Names you trade most (your record)" });
  await expect(names.getByRole("listitem").first()).toContainText("SPY");
  await expect(page.getByRole("list", { name: "This week" })).toContainText("PCE inflation");
  await expect(page.getByRole("list", { name: "This week" })).toContainText("MU");
  // The swing research is closed until asked for, and whole when opened.
  await expect(page.getByRole("list", { name: "Daily radar picks" })).toBeHidden();
  await page.getByText("Swing research: the radar's picks, lists and notes").click();
  await expect(page.getByRole("img", { name: "Market regime: neutral" })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Each list's average move on .* against its benchmark\. SUPPORT PLAYS/ })).toBeVisible();
  const picks = page.getByRole("list", { name: "Daily radar picks" });
  await expect(picks.getByRole("img", { name: /^AMZN: price 253\.71, support 244\.30/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Catalysts this week" })).toContainText("PCE inflation");
  await expect(page.getByRole("heading", { name: "SUPPORT PLAYS", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});


// The pipeline's states, each pinned at the fixture's frozen time (11:01 New York on Monday 2026-10-12), and a market
// holiday. The badge never says "On time" for an edition that came late or that a person built.
for (const [flag, badge, build] of [
  ["frozen", "On time", "done"],
  ["frozen.radar-late", "Late by 3 h 7 min", "done"],
  ["frozen.radar-hand", "Built by hand", "done"],
  ["frozen.radar-refused", "Edition refused", "done"],
  ["frozen.radar-building", /^Radar pipeline: Late by /, "current"],
] as const) {
  test(`the radar pipeline under ${flag}`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "fx", value: flag, url: baseURL! }]);
    await page.goto("/radar");
    await expect(page.getByRole("status", { name: typeof badge === "string" ? `Radar pipeline: ${badge}` : badge })).toBeVisible();
    const stages = page.getByRole("list", { name: "The Radar pipeline for Mon 12 Oct" }).getByRole("listitem");
    await expect(stages).toHaveCount(7);
    await expect(stages.nth(1)).toHaveAttribute("data-rail-state", build);
    await expect(stages.nth(2)).toHaveAttribute("data-rail-state", flag === "frozen.radar-refused" ? "failed" : flag === "frozen.radar-building" ? "late" : "done");
  });
}

test("the radar pipeline on a market holiday says there is no session, and nothing is late", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "radar-holiday", url: baseURL! }]);
  await page.goto("/radar");
  const badge = page.getByRole("status", { name: "Radar pipeline: No session today" });
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Thanksgiving");
  const stages = page.getByRole("list", { name: /^The Radar pipeline for / }).getByRole("listitem");
  await expect(stages).toHaveCount(7);
  await expect(page.locator('[data-rail-state="late"], [data-rail-state="failed"]')).toHaveCount(0);
});

test("with no stored documents the radar page still shows the pipeline's schedule", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "fx", value: "empty", url: baseURL! }]);
  await page.goto("/radar");
  await expect(page.getByRole("status", { name: /^Radar pipeline: (Schedule only|No session today)$/ })).toBeVisible();
  await expect(page.getByRole("list", { name: /^The Radar pipeline for / }).getByRole("listitem")).toHaveCount(7);
});

test("the stock robot's old address lands on the Gap Hunter page, which shows the host's own block in counts", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/robot-b");
  await expect(page).toHaveURL(/\/gap-hunter$/);
  await expect(page.getByRole("heading", { level: 1, name: "Gap Hunter" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Robot B" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Paper account (Alpaca): Gap Hunter", exact: true })).toHaveAttribute("data-env", "paper");
  // DEC-0078: what it is doing now leads the page, in the paper frame
  await expect(page.getByRole("region", { name: "What Gap Hunter is doing now" })).toContainText("Paper money only");
  await expect(page.getByRole("region", { name: "Gap Hunter at a glance" })).toContainText("Rule DEC-0068");
  for (const name of ["Its day", "Position", "Today's name and its rules", "What it did", "Safety", "Orders", "Closed trades", "Where it stands", "Morning funnel", "Trades and results", "Session runs", "Alerts"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("First pick: Yes")).toBeVisible();                   // the fixture's gap_hunter block
  // Nothing of the retired rule, no host name for the robot, and no candidate's symbol: counts only.
  const body = (await page.locator("main").textContent()) ?? "";
  expect(body).not.toMatch(/QQQ|Robot B|sleeve|paper-s|[Hh]oldout|\bG1\b|LABT/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the Paper page shows two books, the lab's tape, and nothing of the closed hand-traded account", async ({ page }) => {
  await page.goto("/paper");
  const bar = page.getByRole("navigation", { name: "On this page" });
  await expect(bar.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("heading", { level: 2, name: "Clone bot" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Options lab", exact: true })).toBeVisible();
  await expect(page.locator("[data-lab-session]").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Research arms" })).toBeVisible();
  await expect(page.getByText("Two separate books.")).toBeVisible();
  await expect(page.getByText(/My paper trades|hand-placed/i)).toHaveCount(0);
});

test("the Strategies page sums up the three robots and keeps the retired rule in one closed section at its foot", async ({ page }) => {
  await page.goto("/strategies");
  const robots = page.locator("[data-robot]");
  await expect(robots).toHaveCount(3);
  await expect(robots.nth(1)).toContainText("Gap Hunter");
  await expect(robots.nth(1)).toHaveAttribute("href", "/gap-hunter");
  const retired = page.getByTestId("retired-rule");
  await expect(retired).not.toHaveAttribute("open", "");
  await expect(retired.locator("summary")).toHaveText("Retired: QQQ rule (DEC-0062, DEC-0069)");
  await retired.locator("summary").click();
  await expect(retired).toContainText("Verdict");
  await expect(retired.getByRole("link")).toHaveCount(0);
});

test("today draws the three robots and the session clock", async ({ page }) => {
  // 11:02 New York on the fixture's trading day, so the clock shows "now".
  await page.clock.setFixedTime(new Date("2026-09-29T15:02:00Z"));
  await page.goto("/today");
  // The owner's own day comes first: the journal's latest session, its trades drawn on the clock.
  await expect(page.getByRole("heading", { name: /^Your (day|last session) · / })).toBeVisible();
  await expect(page.getByTestId("trade-clock")).toBeVisible();
  await expect(page.getByRole("heading", { name: "The three robots (paper)", exact: true })).toBeVisible();
  await expect(page.locator("[data-robot]")).toHaveCount(3);
  const clock = page.getByRole("img", { name: /^The New York day 2026-09-29 from 04:00 to 20:00/ });
  await expect(clock).toBeVisible();
  // Every lane ends in a word, never colour alone: the fixture's routine run failed.
  await expect(page.getByTestId("clock-routine")).toContainText("failed");
  // Gap Hunter's session has a lane before the host has reported a run; the retired rule's job has none.
  await expect(page.getByTestId("clock-paper-s")).toContainText("no run");
  await expect(page.getByTestId("clock-paper-b")).toHaveCount(0);
  await expect(page.getByTestId("clock-now")).toContainText("now 11:02");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the v3 panels render from the fixture, and the glossary is linked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/risk");
  await expect(page.getByText("Robot alerts and the kill switch")).toBeVisible();
  await expect(page.getByRole("heading", { name: "The three robots (paper)", exact: true })).toBeVisible();
  await page.goto("/operations");
  await expect(page.getByRole("heading", { name: "Your feeds" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Job reliability, 14 days" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible();
  await page.goto("/strategies");
  await expect(page.getByRole("heading", { name: "Forward test scorecard" })).toBeVisible();
  await page.goto("/research");
  await expect(page.getByRole("heading", { name: "Since the last trading day" })).toBeVisible();
  await page.getByRole("link", { name: "Glossary" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Glossary" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the Overview leads with the owner's own trading, then the robots and the lab's health", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByTestId("rule-streak")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Profit and loss" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Your patterns in / })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The three robots (paper)", exact: true })).toBeVisible();
  await expect(page.locator("[data-robot]")).toHaveCount(3);
  await expect(page.getByTestId("scan-line")).toContainText("Pre-market scan");
  // The fixture's snapshot is weeks old and the server runs on the real clock: inside a trading window that is RED
  // ("stopped") and the health shows as the banner at the top, otherwise as the line at the foot. Exactly one of them.
  const healthLine = page.getByTestId("health-line");
  const healthBanner = page.locator('section[aria-labelledby="health-title"]');
  await expect(healthLine.or(healthBanner)).toHaveCount(1);
  await expect(healthLine.or(healthBanner)).toBeVisible();
  // The lab's own panels moved: the gates to Research, the jobs and decisions to Operations.
  await expect(page.getByRole("heading", { name: "Gate tracker" })).toHaveCount(0);
  await page.goto("/research");
  await expect(page.getByRole("heading", { name: "Gate tracker" })).toBeVisible();
  await page.goto("/operations");
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
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
      options_live: { status: "ok", accepts: 3, run_id: expect.any(String) },
      options_clone: { status: "ok", accepts: 1, session: "2026-10-12", run_id: expect.any(String) },
    },
  });
});

test("the focus route refuses a request that is not signed", async ({ request }) => {
  // No ingest key on the fixture server: refused before anything is read. The answer names nothing of the edition.
  const res = await request.get("/api/focus");
  expect([401, 503]).toContain(res.status());
  expect(await res.text()).not.toMatch(/SPY|QQQ|session/);
});

test("the Trades page draws the clone's session, and its bad day, apart from the journal", async ({ page, context, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  expect((await page.goto("/trades"))?.status()).toBe(200);
  const clone = page.locator("#clone");
  await expect(clone.getByRole("heading", { name: "Options clone (paper)" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Paper account (Alpaca): Options clone" })).toHaveAttribute("data-env", "paper");
  await expect(clone.getByText("2 of 5")).toBeVisible();
  await expect(clone.getByRole("cell", { name: "SPY261012C00581000" })).toBeVisible();
  await expect(clone.getByRole("cell", { name: "+25.5%" })).toBeVisible();
  await expect(clone.getByRole("row", { name: /^NVDA 195 4 1 room 2 · contract 1$/ })).toBeVisible();
  await expect(clone.getByRole("row", { name: /^HYP-0029 14 9/ })).toContainText("Too early");
  await expect(clone.getByRole("alert")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await context.addCookies([{ name: "fx", value: "clone-latched", url: baseURL! }]);
  await page.reload();
  await expect(clone.getByRole("alert")).toContainText("Flatten required");
  await expect(clone.getByText("The day loss latch is on")).toBeVisible();
  await expect(clone.getByText("Entries off: feed, latch")).toBeVisible();

  await context.addCookies([{ name: "fx", value: "clone-off", url: baseURL! }]);
  await page.reload();
  await expect(clone.getByText("No session from the clone yet")).toBeVisible();
  // The journal above is drawn either way.
  await expect(page.getByRole("heading", { level: 1, name: "Trades" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the Day review draws the journal's latest day of positions, a day by its address and a day with none", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  expect((await page.goto("/review"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Day review" })).toBeVisible();
  await expect(page.getByText("Fixture data (DASHBOARD_FIXTURE=1)")).toBeVisible();
  await expect(page.getByRole("region", { name: "The day in four figures" })).toContainText("Rules kept");
  await expect(page.getByText("Board labels are not being recorded yet.")).toBeVisible();
  // Linked from the Trades page, and not a section tab of its own.
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Day review" })).toHaveCount(0);
  const prev = page.getByRole("link", { name: /^Previous day with positions/ });
  await prev.click();
  await expect(page).toHaveURL(/\/review\?day=\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByRole("link", { name: /^Next day with positions/ })).toBeVisible();
  expect((await page.goto("/review?day=2026-10-10"))?.status()).toBe(200);
  await expect(page.getByText("No option positions on this day")).toBeVisible();
  // An address that is not a day is ignored.
  expect((await page.goto("/review?day=tomorrow"))?.status()).toBe(200);
  await expect(page.getByRole("region", { name: "The day in four figures" })).toContainText("Rules kept");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.goto("/trades");
  await expect(page.locator("#today-group").getByRole("link", { name: "Day review" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("ingest refuses writes outside production", async ({ request }) => {
  const res = await request.post("/api/ingest", { data: "{}" });
  expect(res.status()).toBe(403);
});

test("the watchdog requires the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/watchdog");
  expect(res.status()).toBe(401);
});

// ---- the crypto desk (ADR 0005; closed by DEC-0036) ----------------------------------------------------------------

test("the crypto page says the desk is closed, with no sections and no readings", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.goto("/crypto");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Crypto" })).toBeVisible();
  await expect(page.getByText("Closed on 24 October 2026 (DEC-0036)")).toBeVisible();
  await expect(page.getByText("Gate C1: 12 registered trials and 6 challengers, 0 passed.")).toBeVisible();
  // one page: no section tabs, no table, no health banner, and the header says the desk is closed
  await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);
  await expect(page.locator("main table")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Desk closed" })).toBeVisible();
  await expect(page.getByText("24/7")).toHaveCount(0);
  const desk = page.getByRole("navigation", { name: "Desk" });
  await expect(desk.getByRole("link", { name: "Crypto" })).toHaveAttribute("aria-current", "true");
  await expect(desk.getByRole("link", { name: "Stocks" })).not.toHaveAttribute("aria-current", "true");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("the crypto desk's old pages are gone", async ({ page }) => {
  for (const path of ["/crypto/market", "/crypto/strategy", "/crypto/research", "/crypto/learning", "/crypto/operations", "/crypto/risk", "/crypto/engineering"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
});

test("the desk switch moves between the stocks desk and the closed crypto desk", async ({ page }) => {
  await page.goto("/");
  const desk = page.getByRole("navigation", { name: "Desk" });
  await expect(desk.getByRole("link", { name: "Stocks" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByText("Desk closed")).toHaveCount(0);
  await desk.getByRole("link", { name: "Crypto" }).click();
  await expect(page).toHaveURL(/\/crypto$/);
  await expect(page.getByText("Closed on 24 October 2026 (DEC-0036)")).toBeVisible();
  await page.getByRole("navigation", { name: "Desk" }).getByRole("link", { name: "Stocks" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Strategies", exact: true })).toBeAttached();
});

test("the stocks Engineering wiki shows the shared Lab platform", async ({ page }) => {
  await page.goto("/engineering");
  await expect(page.getByRole("heading", { level: 2, name: "Lab platform" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Is the data fresh?", exact: true })).toBeAttached();
  for (const name of ["How a change ships", "Recent check runs", "What leaves the host", "The trading host"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeAttached();
  }
  await expect(page.getByRole("img", { name: /^How a change ships\./ })).toBeAttached();
  await expect(page.getByRole("img", { name: /^Recent check runs: security/ })).toBeAttached();
});

test("the stocks wiki draws the desk from the snapshot and the stored feeds", async ({ page }) => {
  await page.goto("/engineering");
  for (const name of ["At a glance", "Where the data comes from", "Is the data fresh?", "A trading day", "The paper robot's safety", "Research gates", "Runbooks and decisions"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeAttached();
  }
  // The fixture's kill switch is on and its routine's last run failed: the glance and the guard say so.
  const glance = page.getByRole("list", { name: "The stocks desk at a glance" });
  await expect(glance).toContainText("Kill switch on");
  await expect(glance).toContainText("needs a look: routine");
  await expect(glance).toContainText("of 5 on time");
  await expect(page.getByRole("img", { name: /^Where the Stocks site's data comes from\..*routine \(last run failed\)/ })).toBeAttached();
  // Every page's feed is listed with the page it lands on.
  const feeds = page.getByRole("list", { name: "The Stocks site's data feeds" });
  for (const name of ["Overview, Today, Operations", "Options", "Radar", "Trades"]) {
    await expect(feeds.getByRole("link", { name, exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole("img", { name: /^A trading day in New York time, 05:00 to 18:30/ })).toBeAttached();
  await expect(page.getByRole("img", { name: /^Order safety\..*Kill switch on/ })).toBeAttached();
  await expect(page.getByRole("img", { name: /^Research gates: K0 .* G1 .*failed/ })).toBeAttached();
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
  for (const name of ["Build phases", "Recorder", "Pairs", "Strategies", "Books", "Learning"]) {
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  }
  const status = page.getByRole("region", { name: "Desk status" });
  for (const words of ["Paper", "Shadow", "IBKR paper", "Open", "Off"]) await expect(status).toContainText(words);
  await expect(page.getByRole("list", { name: "Build phases in order" }).getByRole("listitem")).toHaveCount(8);
  await expect(page.getByRole("list", { name: "Build phases in order" }).getByRole("listitem").filter({ hasText: "F3" })).toContainText("Now");
  const pairs = page.getByRole("region", { name: "Currency pairs" });
  await expect(pairs.getByRole("columnheader")).toHaveText(["Pair", "Form", "Last quote", "Updates a second", "Median spread"]);
  await expect(pairs.getByRole("cell", { name: "EUR.USD" })).toBeVisible();
  const sleeves = page.getByRole("region", { name: "Strategies" });
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
  // the desk is parked (src/lib/desks.json, HFT-DEC-0005): the page says so, with the date and the record
  await expect(page.getByText("The HFT desk is parked")).toBeVisible();
  await expect(page.getByText("stopped on 14 October 2026 (HFT-DEC-0005)", { exact: false })).toBeVisible();
  await expect(page.getByText("This page fills in when the desk is restarted", { exact: false })).toBeVisible();
  await expect(page.getByText("has not published yet")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "What this page will show" })).toBeVisible();
  // nothing that looks like a reading: no banner, no table, no badge, and not one digit beyond the phases' names
  // and the parked date
  const main = page.locator("main");
  await expect(main.locator("#health-title")).toHaveCount(0);
  await expect(main.locator("table")).toHaveCount(0);
  await expect(main.locator('[data-slot="badge"]')).toHaveCount(0);
  expect(((await main.innerText()) ?? "").replace("F0 to F7", "").replace(/stopped on 14 October 2026 \(HFT-DEC-0005\)/, "")).not.toMatch(/\d|—/);
  // the header says there is no data, and the footer names no snapshot
  await expect(page.getByRole("banner").getByRole("status")).toHaveText(/^Lab host \(VM\): no data yet/);
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
  await expect(page.getByText("Desk closed")).toBeVisible();
  await page.getByRole("navigation", { name: "Desk" }).getByRole("link", { name: "Stocks" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Strategies", exact: true })).toBeAttached();
});

test("health reports the HFT desk beside the crypto desk, each with its state word", async ({ request }) => {
  const body = await (await request.get("/api/health")).json();
  expect(body.desks).toEqual({
    crypto: { snapshot: "ok", as_of: expect.any(String), run_id: expect.any(String), state: "closed" },
    hft: { snapshot: "ok", as_of: "2026-10-09T14:30:00+00:00", run_id: "20261009T143000Z-fixture", state: "parked" },
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
      // Static or relative both scroll with the page; sticky or fixed would not.
      expect(["static", "relative"], at).toContain(h.position);
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
      expect(h.position, at).toBe("sticky");
      expect(h.overflow, at).toBeLessThanOrEqual(0);
      if (path === "/crypto") {
        // a closed desk has no sections (DEC-0036), so its header is one row shorter and sizes nothing
        expect(h.sections, at).toBeNull();
        continue;
      }
      expect(h.sections!.top, at).toBeGreaterThanOrEqual(h.desk!.bottom);
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
