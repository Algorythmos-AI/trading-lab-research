import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { alpacaDataUrl, feedsFor } from "@/lib/alpaca-data-url";

// B9 (docs/runbooks/keys-and-feeds.md): an Alpaca market-data request that leaves out `feed` reads whatever the
// subscription allows, so its data source changes with the plan. Every request URL is built by alpacaDataUrl, which
// refuses one without a feed; the scan below fails on any data path written anywhere else.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILDER = "src/lib/alpaca-data-url.ts";
/** A data path that takes a feed: the stock endpoints and the option quote endpoints. */
const FEED_PATH = /\/v2\/stocks\/|\/v1beta1\/options\/(snapshots|(quotes|trades|bars)\/latest)/;

/**
 * Data paths written outside the builder, each awaiting the owner's decision. Phase 1 of B9 found none in the
 * dashboard; an entry here reads "file: the literal's text", with the comment "implicit: awaiting the owner's
 * decision (B9)". The scan fails on a new one, and on an entry that no longer exists.
 */
const KNOWN_IMPLICIT: readonly string[] = [];

describe("alpacaDataUrl", () => {
  it("builds the URL with the query in the order given", () => {
    expect(alpacaDataUrl("https://data.example", "/v2/stocks/snapshots", { symbols: "SPY,QQQ", feed: "iex" })).toBe(
      "https://data.example/v2/stocks/snapshots?symbols=SPY%2CQQQ&feed=iex",
    );
    expect(alpacaDataUrl("https://d.x", "/v1beta1/options/snapshots/SPY", { feed: "indicative", limit: "1000", page_token: "t" })).toBe(
      "https://d.x/v1beta1/options/snapshots/SPY?feed=indicative&limit=1000&page_token=t",
    );
  });

  it("is the same string the stock snapshot request built by hand before", () => {
    const due = ["SPY", "BRK.B", "QQQ"];
    const before = `https://d.x/v2/stocks/snapshots?symbols=${encodeURIComponent(due.join(","))}&feed=sip`;
    expect(alpacaDataUrl("https://d.x", "/v2/stocks/snapshots", { symbols: due.join(","), feed: "sip" })).toBe(before);
  });

  it("refuses a request that does not name its feed, or names another kind's", () => {
    expect(() => alpacaDataUrl("https://d.x", "/v2/stocks/bars", { symbols: "SPY" })).toThrow(/must name its feed/);
    expect(() => alpacaDataUrl("https://d.x", "/v2/stocks/bars", { symbols: "SPY", feed: "" })).toThrow(/must name its feed/);
    expect(() => alpacaDataUrl("https://d.x", "/v2/stocks/bars", { feed: "indicative" })).toThrow(/iex or sip/);
    expect(() => alpacaDataUrl("https://d.x", "/v1beta1/options/snapshots/SPY", { feed: "iex" })).toThrow(/indicative or opra/);
    expect(() => alpacaDataUrl("https://d.x", "/v1beta1/news", { feed: "iex" })).toThrow(/not an Alpaca market-data path/);
  });

  it("knows which paths take which feeds", () => {
    expect(feedsFor("/v2/stocks/quotes/latest")).toEqual(["iex", "sip"]);
    expect(feedsFor("/v1beta1/options/quotes/latest")).toEqual(["indicative", "opra"]);
    expect(feedsFor("/v1beta1/options/bars")).toBeNull();
    expect(feedsFor("/v1beta1/news")).toBeNull();
  });
});

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
    return /\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Each string or template literal holding a feed-taking data path that is not alpacaDataUrl's path argument. */
function strayDataPaths(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const literalText = (n: ts.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    return null;
  };
  const isBuilderPath = (n: ts.Node): boolean => {
    for (let child = n, p = n.parent; p; child = p, p = p.parent) {
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "alpacaDataUrl") return p.arguments[1] === child;
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    const t = literalText(n);
    if (t !== null && FEED_PATH.test(t) && !isBuilderPath(n)) out.push(`${file}: ${t}`);
    if (!ts.isTemplateExpression(n)) ts.forEachChild(n, visit);
    else n.templateSpans.forEach((s) => visit(s.expression));
  };
  visit(sf);
  return out;
}

describe("every Alpaca data request names its feed (scan)", () => {
  const files = [...sources("src"), ...sources("scripts")].filter((f) => f !== BUILDER);
  const found = files.flatMap((f) => strayDataPaths(f, readFileSync(join(ROOT, f), "utf8")));

  it("scans the sources it should", () => {
    for (const f of ["src/lib/bars.ts", "src/lib/quote.ts", "src/lib/chain.ts", "src/lib/feed-agreement-fetch.ts"]) expect(files).toContain(f);
  });

  it("finds no data path outside alpacaDataUrl beyond the known exceptions", () => {
    expect(found.filter((x) => !KNOWN_IMPLICIT.includes(x))).toEqual([]);
  });

  it("every known exception still exists", () => {
    expect(KNOWN_IMPLICIT.filter((x) => !found.includes(x))).toEqual([]);
  });

  it("flags a path written by hand, and passes one given to the builder", () => {
    const bad = 'const u = `${base}/v2/stocks/bars?feed=${f}`; fetch(u); const v = base + "/v1beta1/options/snapshots/SPY";';
    expect(strayDataPaths("x.ts", bad)).toEqual(["x.ts: ${}/v2/stocks/bars?feed=${}", "x.ts: /v1beta1/options/snapshots/SPY"]);
    const good = 'alpacaDataUrl(base, "/v2/stocks/bars", q); alpacaDataUrl(base, `/v1beta1/options/snapshots/${s}`, p); // "/v2/stocks/x" in a comment';
    expect(strayDataPaths("y.ts", good)).toEqual([]);
    // A path passed as some other argument of the builder is not its path.
    expect(strayDataPaths("z.ts", 'alpacaDataUrl("/v2/stocks/bars", p, q);')).toEqual(["z.ts: /v2/stocks/bars"]);
  });
});
