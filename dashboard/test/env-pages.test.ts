// The evidence-class guard on whole pages (B2): the Options desk, Today, Trades and Risk, server-rendered from the
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

const { default: OptionsPage } = await import("@/app/options/page");
const { default: TodayPage } = await import("@/app/today/page");
const { default: TradesPage } = await import("@/app/trades/page");
const { default: RiskPage } = await import("@/app/risk/page");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("DASHBOARD_FIXTURE", "1");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const params = <T extends Record<string, string>>(q: T) => ({ searchParams: Promise.resolve(q) });
const RENDER: Record<GuardedPage, () => Promise<string>> = {
  // The live view: the one that draws the paper positions pane. The rule replay is in the folded research section.
  options: async () => renderToString(await OptionsPage({ searchParams: Promise.resolve({ d: undefined, view: "live", s: undefined, pane: undefined, all: undefined }) })),
  today: async () => renderToString(await TodayPage()),
  trades: async () => renderToString(await TradesPage(params({}))),
  risk: async () => renderToString(await RiskPage()),
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
});

describe("money on the guarded pages", () => {
  it("is drawn through Money where the B2 pages put it: real on Today and Trades, paper wherever a paper frame holds dollars", async () => {
    const [options, today, trades, risk] = await Promise.all([RENDER.options(), RENDER.today(), RENDER.trades(), RENDER.risk()]);
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

  it("never shows paper's US$ inside a real figure, nor real's bare $ inside a paper one", async () => {
    const html = (await Promise.all(Object.values(RENDER).map((r) => r()))).join("");
    for (const m of html.matchAll(/<span data-money="" data-env="(real|paper)"[^>]*>([^<]*)<\/span>/g)) {
      if (m[1] === "real") expect(m[2]).not.toContain("US$");
      else expect(m[2] === "—" || m[2]!.includes("US$")).toBe(true);
    }
  });
});

describe("the B2 wording", () => {
  const text = (html: string) => unescape(html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

  it("names each non-real region by what it is, and no longer calls a rule on probation paper", async () => {
    const options = text(await RENDER.options());
    expect(options).toContain("PAPER · ALPACA (manual)");
    expect(options).toContain("Rule replay (model)");
    expect(options).not.toMatch(/Paper scorecard|Paper positions|paper rules?\b/);
    const today = text(await RENDER.today());
    expect(today).toContain("Robot B (paper)");
    expect(today).not.toContain("The robots, paper money only");
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
