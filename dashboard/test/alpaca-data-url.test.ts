import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { alpacaDataUrl, feedsFor } from "@/lib/alpaca-data-url";

// B9 (docs/runbooks/keys-and-feeds.md): an Alpaca market-data request that leaves out `feed` reads whatever the
// subscription allows, so its data source changes with the plan. Every request URL is built by alpacaDataUrl, which
// refuses one without a feed; the scan below fails on any data path written anywhere else.
//
// Known limits of the scan (what covers each): a URL whose base and path both arrive from outside the file (a
// parameter with no data-base default, a constant imported under another name) is not seen as a data request; a
// fetch through a wrapper that takes a finished URL string is checked only where the URL is built. In both cases the
// URL is still refused at run time if it goes through alpacaDataUrl; one that bypasses the builder entirely and
// hides both pieces is not caught. Feed removal by string surgery (`.replace(/feed=.../)`) is not followed.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILDER = "src/lib/alpaca-data-url.ts";
/** A data path that takes a feed, with or without its leading slash: stock data, and option quotes. */
const FEED_PATH = /(?:^|\/|\})v2\/stocks\/(?!meta\/|auctions)|(?:^|\/|\})v1beta1\/options\/(?:snapshots|(?:quotes|trades|bars)\/latest)/;
/** A piece of one beside a data base ("/stocks/", "stocks/bars", "options/snapshots"). */
const PIECE = /(?:^|\/)(?:stocks\/(?!meta\/|auctions)|stocks\/?$|options\/(?:snapshots|(?:quotes|trades|bars)\/latest))/;
const HOST = "data.alpaca.markets";
const BASE_NAMES = new Set(["DEFAULT_DATA_URL", "ALPACA_DATA_URL"]);

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
    expect(feedsFor("/v2/stocks/meta/exchanges")).toBeNull();
    expect(feedsFor("/v2/stocks/SPY/snapshot")).toEqual(["iex", "sip"]);
  });
});

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
    return /\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const literalText = (n: ts.Node): string | null => {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
  return null;
};
const unwrap = (n: ts.Node): ts.Node => (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) ? unwrap(n.expression) : n);
const callee = (c: ts.CallExpression): string => {
  const e = unwrap(c.expression);
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
};
const isBuilderCall = (n: ts.Node): boolean => ts.isCallExpression(unwrap(n)) && callee(unwrap(n) as ts.CallExpression) === "alpacaDataUrl";

/**
 * Every way `text` may send an Alpaca data request without alpacaDataUrl:
 * 1. a string or template literal holding a data path (slash or not) that is not, itself, the builder's path argument;
 * 2. a piece of one ("stocks/bars") joined to a data base (the host, ALPACA_DATA_URL, DEFAULT_DATA_URL, or a name
 *    given one of them) by `+`, a template or `new URL(path, base)`;
 * 3. a fetch-like call (fetch, fetchImpl, ...) whose target holds a data base and is not alpacaDataUrl(...) or a name
 *    assigned from it;
 * 4. a call that removes or blanks `feed` in a URL's query (`.delete("feed")`, `.set("feed", ...)`).
 */
function strayDataPaths(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  // Names given a data base, and names assigned from the builder, anywhere in the file (followed to a fixpoint).
  const inits: [string, ts.Node][] = [];
  const collect = (n: ts.Node): void => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name) && n.initializer) inits.push([n.name.text, n.initializer]);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) inits.push([n.left.text, n.right]);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const bases = new Set(BASE_NAMES);
  const built = new Set<string>();
  const mentionsBase = (n: ts.Node): boolean => {
    let hit = false;
    const walk = (m: ts.Node): void => {
      if (hit) return;
      if (ts.isIdentifier(m) && bases.has(m.text)) hit = true;
      else if (ts.isPropertyAccessExpression(m) && bases.has(m.name.text)) hit = true;
      else if ((literalText(m) ?? "").includes(HOST)) hit = true;
      else ts.forEachChild(m, walk);
    };
    walk(n);
    return hit;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, init] of inits) {
      if (isBuilderCall(init) && !built.has(name)) built.add(name), (grew = true);
      else if (!isBuilderCall(init) && !bases.has(name) && mentionsBase(init)) bases.add(name), (grew = true);
    }
  }
  const isBuilderPath = (n: ts.Node): boolean => {
    let child: ts.Node = n;
    let p = n.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) (child = p), (p = p.parent);
    return !!p && ts.isCallExpression(p) && callee(p) === "alpacaDataUrl" && p.arguments[1] === child;
  };
  /** The pieces of a `+` chain or a template, as text and nodes. */
  const pieces = (n: ts.Node): ts.Node[] => {
    const u = unwrap(n);
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...pieces(u.left), ...pieces(u.right)];
    if (ts.isTemplateExpression(u)) return [u.head, ...u.templateSpans.flatMap((s) => [s.expression, s.literal])];
    return [u];
  };
  const pieceText = (m: ts.Node): string | null =>
    ts.isTemplateHead(m) || ts.isTemplateMiddle(m) || ts.isTemplateTail(m) ? m.text : literalText(m);
  const joinsBase = (n: ts.Node): boolean => {
    const ps = pieces(n);
    return ps.length > 1 && ps.some((m) => mentionsBase(m)) && ps.some((m) => PIECE.test(pieceText(m) ?? ""));
  };
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    const t = literalText(n);
    if (t !== null && FEED_PATH.test(t) && !isBuilderPath(n)) out.push(`${file}: ${t}`);
    if ((ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) || ts.isTemplateExpression(n)) {
      if (joinsBase(n) && !FEED_PATH.test(t ?? "")) out.push(`${file}:${line(n)}: a data path joined to a data base`);
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "URL" && n.arguments && n.arguments.length >= 2) {
      const [rel, base] = n.arguments;
      if (mentionsBase(base!) && !isBuilderCall(rel!) && !FEED_PATH.test(literalText(rel!) ?? "")) out.push(`${file}:${line(n)}: new URL(path, data base)`);
    }
    if (ts.isCallExpression(n)) {
      const name = callee(n);
      const target = n.arguments[0];
      if (/fetch/i.test(name) && name !== "alpacaDataUrl" && target && mentionsBase(target)) {
        const u = unwrap(target);
        if (!isBuilderCall(u) && !(ts.isIdentifier(u) && built.has(u.text))) out.push(`${file}:${line(n)}: ${name}() to a data base without alpacaDataUrl`);
      }
      if ((name === "delete" || name === "set") && n.arguments[0] && literalText(n.arguments[0]) === "feed") out.push(`${file}:${line(n)}: .${name}("feed") on a query`);
    }
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

  it("finds no data request outside alpacaDataUrl beyond the known exceptions", () => {
    expect(found.filter((x) => !KNOWN_IMPLICIT.includes(x))).toEqual([]);
  });

  it("every known exception still exists", () => {
    expect(KNOWN_IMPLICIT.filter((x) => !found.includes(x))).toEqual([]);
  });

  it("passes requests built by the builder", () => {
    const good = [
      'alpacaDataUrl(base, "/v2/stocks/bars", q); alpacaDataUrl(base, `/v1beta1/options/snapshots/${s}`, p); // "/v2/stocks/x" in a comment',
      'const baseUrl = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL; const url = alpacaDataUrl(baseUrl, "/v2/stocks/snapshots", { feed }); await fetchImpl(url, {});',
      'const base = o.baseUrl ?? DEFAULT_DATA_URL; await fetchImpl(alpacaDataUrl(base, "/v2/stocks/bars", q));',
      'await fetch("/api/quote?s=SPY"); await fetch(`${INGEST}/v2/editions`); q.set("page_token", t); m.delete("SPY");',
      'const u = `${DEFAULT_DATA_URL}/v1beta1/news`; const meta = DEFAULT_DATA_URL + "/v2/stocks/meta/exchanges";',
    ];
    for (const g of good) expect(strayDataPaths("y.ts", g), g).toEqual([]);
  });

  // The cases the B9 review found the first scan missed: each must now be caught.
  const MISSED: Record<string, string> = {
    "a path by hand": 'const u = `${base}/v2/stocks/bars?feed=${f}`; fetch(u);',
    "no leading slash": 'fetch(DEFAULT_DATA_URL + "/" + "v2/stocks/bars?symbols=SPY");',
    "a piece beside a data base": 'const b = process.env.ALPACA_DATA_URL; fetch(b + "/v2" + "/stocks/bars");',
    "a piece in a template": 'const base = DEFAULT_DATA_URL; const u = `${base}/v2/${"stocks"}/bars`;',
    "new URL(relative, base)": 'const u = new URL(path, process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL); await fetch(u);',
    "fetch to a data base by a variable": 'const baseUrl = process.env.ALPACA_DATA_URL ?? "x"; const url = baseUrl + p; await fetchImpl(url);',
    "fetch to the host literal": 'await fetch(`https://data.alpaca.markets${path}`);',
    "a data path nested in a call in the builder's path argument": 'alpacaDataUrl(base, join("/v2/stocks/bars"), q);',
    "a data path in another argument of the builder": 'alpacaDataUrl("/v2/stocks/bars", p, q);',
    "feed removed from a built URL": 'const u = new URL(alpacaDataUrl(base, "/v2/stocks/bars", q)); u.searchParams.delete("feed"); u.searchParams.set("feed", "");',
  };
  for (const [name, src] of Object.entries(MISSED))
    it(`catches: ${name}`, () => {
      expect(strayDataPaths("x.ts", src).length, src).toBeGreaterThan(0);
    });
  it("would catch the real request sites if they bypassed the builder", () => {
    const bars = readFileSync(join(ROOT, "src/lib/bars.ts"), "utf8").replace('alpacaDataUrl(baseUrl, "/v2/stocks/bars", q)', "`${baseUrl}/v2/stocks/bars?${new URLSearchParams(q)}`");
    expect(strayDataPaths("bars.ts", bars).length).toBeGreaterThan(0);
    const quote = readFileSync(join(ROOT, "src/lib/quote.ts"), "utf8").replace(
      'alpacaDataUrl(baseUrl, "/v2/stocks/snapshots", { symbols: due.join(","), feed })',
      "baseUrl + `/v2/stocks/snapshots?symbols=${due.join(\",\")}`",
    );
    expect(strayDataPaths("quote.ts", quote).length).toBeGreaterThan(0);
    const chain = readFileSync(join(ROOT, "src/lib/chain.ts"), "utf8").replace("alpacaDataUrl(baseUrl, `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`, params)", "new URL(`v1beta1/options/snapshots/${symbol}`, baseUrl)");
    expect(strayDataPaths("chain.ts", chain).length).toBeGreaterThan(0);
  });

  it("names both removals of the feed", () => {
    expect(strayDataPaths("x.ts", MISSED["feed removed from a built URL"]!)).toEqual(['x.ts:1: .delete("feed") on a query', 'x.ts:1: .set("feed") on a query']);
  });
});
