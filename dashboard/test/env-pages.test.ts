// The evidence-class guard on whole pages (B2): the Overview, the Options desk, Today, Trades and Risk, server-rendered from the
// fixtures (fixture mode, as the browser tests run them). On each page every money figure sits in an EnvFrame of its
// own class (test/env-guard.ts), and the page shows exactly the non-real frames test/env-allowlist.ts lists for it,
// so paper, simulated and model numbers can never sit where the owner's real Webull money is read.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_META, isEnv, type Env } from "@/lib/env";
import { NON_REAL_FRAMES, type GuardedPage } from "./env-allowlist";
import { assertOnlyEnvs, envViolations } from "./env-guard";

// Client components ask for the router; no app router is mounted under a server render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
// Anything not served from a fixture reads an empty store, never the network.
vi.mock("@vercel/blob", async () => (await import("./blob-sdk")).makeFakeBlobSdk());

const { default: OverviewPage } = await import("@/app/page");
const { default: OptionsPage } = await import("@/app/options/page");
const { default: TodayPage } = await import("@/app/today/page");
const { default: TradesPage } = await import("@/app/trades/page");
const { default: RiskPage } = await import("@/app/risk/page");
const { default: PaperPage } = await import("@/app/paper/page");
const { default: RobotBPage } = await import("@/app/robot-b/page");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("DASHBOARD_FIXTURE", "1");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const params = <T extends Record<string, string>>(q: T) => ({ searchParams: Promise.resolve(q) });
const RENDER: Record<GuardedPage, () => Promise<string>> = {
  overview: async () => renderToString(await OverviewPage()),
  // The live view: the one that draws the paper positions pane. The rule replay is in the folded research section.
  options: async () => renderToString(await OptionsPage({ searchParams: Promise.resolve({ d: undefined, view: "live", s: undefined, pane: undefined, all: undefined }) })),
  today: async () => renderToString(await TodayPage()),
  trades: async () => renderToString(await TradesPage(params({}))),
  risk: async () => renderToString(await RiskPage()),
  paper: async () => renderToString(await PaperPage(params({}))),
  "robot-b": async () => renderToString(await RobotBPage()),
};

const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * Every non-real frame on the markup, as "env: label": the label is the frame's accessible name after its class's
 * name ("Paper account (Alpaca): Robot B" reads "paper: Robot B"). A frame of no known class is listed as it stands.
 */
function nonRealFrames(html: string): string[] {
  const out: string[] = [];
  for (const [tag] of html.matchAll(/<[a-z][^>]*\sdata-env-frame=""[^>]*>/g)) {
    const env = attr(tag, "data-env") ?? "";
    if (env === "real") continue;
    const name = unescape(attr(tag, "aria-label") ?? "");
    const prefix = isEnv(env) ? `${ENV_META[env].name}: ` : "";
    out.push(`${env}: ${prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name}`);
  }
  return out;
}
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/**
 * The markup with every non-real frame and all it holds taken out: what a reader sees as the owner's own page. The
 * guard (env-guard.ts) has already checked the markup is well formed, so the frames close where they should.
 */
function outsideNonReal(html: string): string {
  let out = "";
  let depth = 0;
  let last = 0;
  const stack: boolean[] = [];
  for (const m of html.matchAll(TAG)) {
    if (depth === 0) out += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0].startsWith("<!--")) {
      if (depth === 0) out += m[0];
    } else if (m[1] !== undefined) {
      const frame = stack.pop() ?? false;
      if (frame) depth -= 1;
      else if (depth === 0) out += m[0];
    } else {
      const env = attr(m[0], "data-env");
      const frame = /\sdata-env-frame=""/.test(m[0]) && env !== "real";
      if (depth === 0 && !frame) out += m[0];
      if (VOID.has(m[2]!.toLowerCase()) || /\/>$/.test(m[0])) continue;
      stack.push(frame);
      if (frame) depth += 1;
    }
  }
  return depth === 0 ? out + html.slice(last) : out;
}
const otherEnvs = (html: string) => [...html.matchAll(/\sdata-env="([^"]*)"/g)].map((m) => m[1]!).filter((e) => e !== "real");

const listed = (page: GuardedPage) => NON_REAL_FRAMES[page].map((f) => `${f.env}: ${f.label}`);
const allowed = (page: GuardedPage): Env[] => ["real", ...new Set(NON_REAL_FRAMES[page].map((f) => f.env))];
const moneyOf = (html: string) => [...html.matchAll(/<span data-money="" data-env="([^"]*)"/g)].map((m) => m[1]!);

describe.each(Object.keys(RENDER) as GuardedPage[])("the %s page's evidence classes", (page) => {
  it("keeps every money figure in a frame of its own class, and shows only the classes its frames allow", async () => {
    const html = await RENDER[page]();
    expect(envViolations(html, allowed(page))).toEqual([]);
    assertOnlyEnvs(html, allowed(page));
  });

  it("shows exactly the non-real frames the owner's allowlist names, each once", async () => {
    expect(nonRealFrames(await RENDER[page]()).sort()).toEqual(listed(page).sort());
  });

  it("outside its non-real frames, shows no paper US$ figure and names no class but real", async () => {
    // A paper figure written as text (format.ts's usd) outside a frame has no data-money for the guard to see: this
    // reads what is left once the frames are taken out.
    const rest = outsideNonReal(await RENDER[page]());
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.match(/.{0,80}US\$.{0,40}/g) ?? []).toEqual([]);
    expect(otherEnvs(rest)).toEqual([]);
  });
});

describe("taking the non-real frames out", () => {
  it("leaves what is outside them, and drops what is inside, however deep", () => {
    const html =
      '<main><div data-env-frame="" data-env="paper"><p>US$1<br/><span data-money="" data-env="paper">US$2</span></p><img src="x"/></div>' +
      '<p>US$3 <span data-env="real">$4</span></p><div data-env-frame="" data-env="real"><b>$5</b></div>' +
      '<div data-env-frame="" data-env="model"><div><div>US$6</div></div></div><i>end</i></main>';
    const rest = outsideNonReal(html);
    expect(rest).toBe('<main><p>US$3 <span data-env="real">$4</span></p><div data-env-frame="" data-env="real"><b>$5</b></div><i>end</i></main>');
    expect(otherEnvs(rest)).toEqual([]);
    // So a paper figure written outside every frame is caught.
    expect(rest).toContain("US$3");
  });
});

describe("money on the guarded pages", () => {
  it("is drawn through Money where the B2 pages put it: real on Today and Trades, paper wherever a paper frame holds dollars", async () => {
    const [overview, options, today, trades, risk] = await Promise.all([RENDER.overview(), RENDER.options(), RENDER.today(), RENDER.trades(), RENDER.risk()]);
    // Robot B's one-line result.
    expect(moneyOf(overview)).toEqual(["paper"]);
    // The paper positions' results (three positions and their total).
    expect(moneyOf(options).filter((e) => e === "paper").length).toBeGreaterThanOrEqual(4);
    expect(moneyOf(options)).not.toContain("real");
    // The owner's day result, and Robot B's paper P&L.
    expect(moneyOf(today)).toContain("real");
    expect(moneyOf(today)).toContain("paper");
    // The owner's record and session, and the clone's day result.
    expect(moneyOf(trades)).toContain("real");
    expect(moneyOf(trades)).toContain("paper");
    // Robot B's paper broker account.
    expect(moneyOf(risk).length).toBeGreaterThan(0);
    expect(new Set(moneyOf(risk))).toEqual(new Set(["paper"]));
  });

});

describe("the B2 wording", () => {
  const text = (html: string) => unescape(html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

  it("names each non-real region by what it is, and no longer calls a rule on probation paper", async () => {
    const options = text(await RENDER.options());
    expect(options).toContain("PAPER · ALPACA Manual option positions");
    expect(options).toContain("Rule replay (model)");
    // "Paper" for a rule on probation, in any of the forms it used to take (the panes, the Entry rules key and table,
    // the rule chart's tooltip and counts). "The paper account" for the Alpaca account itself is right and stays.
    const probationAsPaper = /Paper scorecard|Paper positions|paper rules?\b|Paper trades|tracked on paper|live paper|paper so far|paper cases|No paper trades|\. Paper [+−-]?\d/i;
    expect(options).not.toMatch(probationAsPaper);
    expect(unescape(await RENDER.options())).not.toMatch(probationAsPaper); // titles and tooltips too
    const today = text(await RENDER.today());
    expect(today).toContain("Robot B (paper)");
    expect(today).not.toContain("The robots, paper money only");
    // The pre-market scan is the routine's dry run, not Robot B's account: outside every paper frame.
    const todayOwn = text(outsideNonReal(await RENDER.today()));
    expect(todayOwn).toContain("Pre-market scan");
    expect(todayOwn).toContain("Candidates");
    expect(todayOwn).not.toContain("Robot B (paper) session");
    const overview = text(await RENDER.overview());
    expect(overview).toContain("Robot B (paper) and the pre-market scan");
    expect(overview).not.toContain("The robots, paper money only");
    expect(text(await RENDER.trades())).toContain("Options clone (paper)");
    expect(text(await RENDER.risk())).toContain("Robot B (paper)");
  });

  it("the site header does not call the whole site paper", () => {
    const header = readFileSync(fileURLToPath(new URL("../src/components/site-header.tsx", import.meta.url)), "utf8");
    expect(header).not.toContain("Paper research status");
  });
});

// Every <Money> in the source names a class the guard can check: a literal one, so a reader sees which; and every
// file that draws Money also draws (or is drawn inside) an EnvFrame. The rendered checks above are the real proof;
// this keeps a new Money from appearing somewhere no page test renders without an EnvFrame in sight.
describe("Money in the source", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(f) ? [p] : [];
    });
  /** Files that draw Money for a frame drawn by the page that holds them: the frame is named here. */
  const FRAMED_BY = {
    "components/today/trading.tsx": "app/today/page.tsx",
    "components/paper/dollars.tsx": "components/paper/paper-page.tsx",
  } as Record<string, string>;
  const uses = files(SRC)
    .map((p) => ({ rel: p.slice(SRC.length + 1), text: readFileSync(p, "utf8") }))
    .filter((f) => f.rel !== "components/ui/money.tsx" && /<Money\b/.test(f.text));

  it("is used where B2 put it", () => {
    expect(uses.map((f) => f.rel).sort()).toEqual(
      [
        "app/risk/page.tsx",
        "components/client/options-positions.tsx",
        "components/journal.tsx",
        "components/options-clone.tsx",
        "components/overview/home.tsx",
        "components/paper/dollars.tsx",
        "components/today/trading.tsx",
        "components/today/your-day.tsx",
      ].sort(),
    );
  });

  it("always names its class as a literal, and sits in a file with an EnvFrame of that class", () => {
    for (const f of uses) {
      const envs = [...f.text.matchAll(/<Money\b[^>]*?\senv="([a-z]+)"/g)].map((m) => m[1]!);
      const all = [...f.text.matchAll(/<Money\b/g)].length;
      expect(envs.length, `${f.rel}: every <Money> names env="..."`).toBe(all);
      const host = FRAMED_BY[f.rel] ? readFileSync(join(SRC, FRAMED_BY[f.rel]!), "utf8") : f.text;
      for (const env of new Set(envs)) expect(host, `${f.rel}: no EnvFrame env="${env}"`).toMatch(new RegExp(`<EnvFrame\\b[^>]*\\senv="${env}"`));
    }
  });
});
