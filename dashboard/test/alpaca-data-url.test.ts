import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { alpacaDataUrl, alpacaNoFeedUrl, feedsFor, NO_FEED_PATHS, PAUSED_STOCK_FEEDS } from "@/lib/alpaca-data-url";

// B9 (docs/runbooks/keys-and-feeds.md): an Alpaca market-data request that leaves out `feed` reads whatever the
// subscription allows, so its data source changes with the plan. Every request URL is built by alpacaDataUrl, which
// refuses one without a feed; the scan below fails on any data path written anywhere else.
//
// Known limits of the scan: a URL whose base and path both arrive from outside the file (a parameter with no
// data-base default, a constant imported under another name) is not seen as a data request; a base imported under
// another name is caught only when the piece beside it is a whole path (v2/stocks/..., v1beta1/options/...); an HTTP
// client the scan does not know by name (anything but fetch..., axios, got, ky, request, get/post) is not checked;
// feed removal by string surgery (`.replace(/feed=.../)`) and anything dynamic are not followed. A URL built by
// alpacaDataUrl is refused at run time without a feed; one that bypasses the builder and hides both pieces is not
// caught at all.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILDER = "src/lib/alpaca-data-url.ts";
/** A data path that takes a feed, with or without its leading slash: stock data, and option quotes. */
const FEED_PATH = /(?:^|\/|\})v2\/stocks\/(?!meta\/)|(?:^|\/|\})v1beta1\/options\/(?:snapshots|(?:quotes|trades|bars)\/latest)/;
/** A piece of one beside a data base ("/stocks/", "stocks/bars", "options/snapshots"). */
const PIECE = /(?:^|\/)(?:stocks\/(?!meta\/)|stocks\/?$|options\/(?:snapshots|(?:quotes|trades|bars)\/latest))/;
const HOST = "data.alpaca.markets";
const BASE_NAMES = new Set(["DEFAULT_DATA_URL", "ALPACA_DATA_URL"]);

/**
 * Data paths written outside the builder, each awaiting the owner's decision. Phase 1 of B9 found none in the
 * dashboard; an entry here reads "file: the literal's text", with the comment "implicit: awaiting the owner's
 * decision (B9)". The scan fails on a new one, and on an entry that no longer exists.
 */
const KNOWN_IMPLICIT: readonly string[] = [];

describe("alpacaDataUrl", () => {
  it("refuses a paused stock feed, and only on stock paths (DEC-0064)", () => {
    expect(PAUSED_STOCK_FEEDS).toEqual([]); // empty until every consumer reads SIP
    const b = "https://data.example";
    for (const path of ["/v2/stocks/bars", "/v2/stocks/snapshots", "/v2/stocks/quotes/latest", "/v2/stocks/SPY/snapshot"]) {
      expect(() => alpacaDataUrl(b, path, { symbols: "SPY", feed: "iex" }, ["iex"])).toThrow("iex stock feed is paused");
      expect(alpacaDataUrl(b, path, { symbols: "SPY", feed: "sip" }, ["iex"])).toContain("feed=sip");
    }
    expect(alpacaDataUrl(b, "/v1beta1/options/snapshots/SPY", { feed: "opra" }, ["iex"])).toContain("feed=opra");
    expect(alpacaDataUrl(b, "/v2/stocks/bars", { symbols: "SPY", feed: "iex" })).toContain("feed=iex");
  });

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
    expect(feedsFor("/v2/stocks/auctions")).toEqual(["sip"]);
    expect(() => alpacaDataUrl("https://d.x", "/v2/stocks/auctions", { feed: "iex" })).toThrow(/must name its feed \(sip\)/);
  });
});

describe("alpacaNoFeedUrl", () => {
  it("builds the two no-feed paths with the query in the order given", () => {
    expect(alpacaNoFeedUrl("https://d.x", "/v1beta1/options/trades", { symbols: "ABC261218C00050000", start: "s", end: "e", limit: "10000", sort: "asc" })).toBe(
      "https://d.x/v1beta1/options/trades?symbols=ABC261218C00050000&start=s&end=e&limit=10000&sort=asc",
    );
    expect(alpacaNoFeedUrl("https://d.x", "/v1beta1/options/bars", { symbols: "X", timeframe: "1Min" })).toBe("https://d.x/v1beta1/options/bars?symbols=X&timeframe=1Min");
    expect(NO_FEED_PATHS).toEqual(["/v1beta1/options/trades", "/v1beta1/options/bars"]);
    for (const p of NO_FEED_PATHS) expect(feedsFor(p)).toBeNull();
  });

  it("refuses a path that takes a feed, including the latest option trades", () => {
    expect(() => alpacaNoFeedUrl("https://d.x", "/v2/stocks/bars", { symbols: "SPY" })).toThrow(/takes no feed/);
    expect(() => alpacaNoFeedUrl("https://d.x", "/v1beta1/options/snapshots/SPY", {})).toThrow(/takes no feed/);
    expect(feedsFor("/v1beta1/options/trades/latest")).toEqual(["indicative", "opra"]);
    expect(() => alpacaNoFeedUrl("https://d.x", "/v1beta1/options/trades/latest", { symbols: "X" })).toThrow(/takes no feed/);
  });

  it("refuses an unknown path, and one that is not exact", () => {
    for (const p of ["/v1beta1/news", "/v1beta1/options/trades/", "v1beta1/options/trades", "/v1beta1/options/trades?x=1", "/v1beta1/options/quotes"])
      expect(() => alpacaNoFeedUrl("https://d.x", p, {})).toThrow(/takes no feed/);
  });

  it("refuses a feed parameter, whatever its value", () => {
    for (const feed of ["opra", "indicative", "iex", ""]) expect(() => alpacaNoFeedUrl("https://d.x", "/v1beta1/options/trades", { symbols: "X", feed })).toThrow(/takes no feed parameter/);
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
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e)) return literalText(e.argumentExpression) ?? "";
  return "";
};
/** The object a method is called on (`a` in `a.b(...)` or `a["b"](...)`), or null. */
const receiver = (c: ts.CallExpression): ts.Node | null => {
  const e = unwrap(c.expression);
  return ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? e.expression : null;
};
/** An HTTP call: fetch-like, or a client the scan knows by name (axios, got, ky, request, get/post on a client). */
const HTTP_CALLEE = /fetch|^(?:axios|got|ky|request|get|post|put|head)$/i;
const isHttpCall = (c: ts.CallExpression): boolean => {
  const name = callee(c);
  if (BUILDERS.has(name)) return false;
  if (HTTP_CALLEE.test(name)) return true;
  const r = receiver(c);
  return !!r && ts.isIdentifier(unwrap(r)) && /^(?:axios|got|ky|superagent)$/.test((unwrap(r) as ts.Identifier).text);
};
/** The builders: alpacaDataUrl for the paths that take a feed, alpacaNoFeedUrl for the two exact paths that take none. */
const BUILDERS = new Set(["alpacaDataUrl", "alpacaNoFeedUrl"]);
const isBuilderCall = (n: ts.Node): boolean => ts.isCallExpression(unwrap(n)) && BUILDERS.has(callee(unwrap(n) as ts.CallExpression));

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
    return !!p && ts.isCallExpression(p) && BUILDERS.has(callee(p)) && p.arguments[1] === child;
  };
  /** The pieces of a `+` chain or a template, as text and nodes. */
  const pieces = (n: ts.Node): ts.Node[] => {
    const u = unwrap(n);
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...pieces(u.left), ...pieces(u.right)];
    if (ts.isCallExpression(u) && callee(u) === "concat" && receiver(u)) return [...pieces(receiver(u)!), ...u.arguments.flatMap((a) => pieces(a))];
    if (ts.isCallExpression(u) && callee(u) === "join" && receiver(u) && ts.isArrayLiteralExpression(unwrap(receiver(u)!)))
      return (unwrap(receiver(u)!) as ts.ArrayLiteralExpression).elements.flatMap((el) => pieces(el));
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
    const chain =
      (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) ||
      ts.isTemplateExpression(n) ||
      (ts.isCallExpression(n) && (callee(n) === "concat" || (callee(n) === "join" && !!receiver(n) && ts.isArrayLiteralExpression(unwrap(receiver(n)!)))));
    if (chain) {
      if (joinsBase(n) && !FEED_PATH.test(t ?? "")) out.push(`${file}:${line(n)}: a data path joined to a data base`);
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "URL" && n.arguments && n.arguments.length >= 2) {
      const [rel, base] = n.arguments;
      if (mentionsBase(base!) && !isBuilderCall(rel!) && !FEED_PATH.test(literalText(rel!) ?? "")) out.push(`${file}:${line(n)}: new URL(path, data base)`);
    }
    if (ts.isCallExpression(n)) {
      const name = callee(n);
      const target = n.arguments[0];
      if (isHttpCall(n) && target && mentionsBase(target)) {
        const u = unwrap(target);
        if (!isBuilderCall(u) && !(ts.isIdentifier(u) && built.has(u.text))) out.push(`${file}:${line(n)}: ${name}() to a data base without alpacaDataUrl`);
      }
      if ((name === "delete" || name === "set" || name === "append") && n.arguments[0] && literalText(n.arguments[0]) === "feed") out.push(`${file}:${line(n)}: .${name}("feed") on a query`);
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
      'const base = o.baseUrl ?? DEFAULT_DATA_URL; const url = alpacaNoFeedUrl(base, "/v1beta1/options/trades", q); await fetchImpl(url, {});',
      'await fetch(alpacaNoFeedUrl(DEFAULT_DATA_URL, "/v1beta1/options/bars", q));',
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
    ".concat beside a data base": 'const u = DEFAULT_DATA_URL.concat("/v2/", "stocks/bars"); await fetch(u);',
    "axios to a data base": 'await axios.get(`${DEFAULT_DATA_URL}${p}`);',
    "got to a data base": 'await got(process.env.ALPACA_DATA_URL + p);',
    "request to a data base": 'request({ url: DEFAULT_DATA_URL + p });',
    'searchParams["delete"]("feed")': 'const u = new URL(alpacaDataUrl(base, "/v2/stocks/bars", q)); u.searchParams["delete"]("feed");',
    '.append("feed", "")': 'const u = new URL(alpacaDataUrl(base, "/v2/stocks/bars", q)); u.searchParams.append("feed", "");',
    'an array .join("/") with a data base': 'const u = [DEFAULT_DATA_URL, "v2", "stocks", "bars"].join("/");',
    "feed removed from a built URL": 'const u = new URL(alpacaDataUrl(base, "/v2/stocks/bars", q)); u.searchParams.delete("feed"); u.searchParams.set("feed", "");',
    "option trades by hand to a data base": 'await fetch(`${DEFAULT_DATA_URL}/v1beta1/options/trades?symbols=${s}`);',
    "option trades by hand through a name": 'const base = process.env.ALPACA_DATA_URL || DEFAULT_DATA_URL; const u = `${base}/v1beta1/options/trades?${p}`; await fetchImpl(u);',
    "option trades by hand inside a helper call": 'const base = DEFAULT_DATA_URL; await fetchImpl(tradesUrl(base, q, t));',
    "a feed-taking path handed to the no-feed builder's neighbour argument": 'alpacaNoFeedUrl("/v2/stocks/bars", p, q);',
  };
  for (const [name, src] of Object.entries(MISSED))
    it(`catches: ${name}`, () => {
      expect(strayDataPaths("x.ts", src).length, src).toBeGreaterThan(0);
    });
  it("would catch the fill-time check's request if it bypassed the builder", () => {
    const src = readFileSync(join(ROOT, "src/lib/fill-check-fetch.ts"), "utf8");
    expect(strayDataPaths("fill-check-fetch.ts", src)).toEqual([]);
    const byHand = src.replace("const url = alpacaNoFeedUrl(base, TRADES_PATH, tradesParams(q, token));", "const url = `${base}/v1beta1/options/trades?${new URLSearchParams(tradesParams(q, token))}`;");
    expect(byHand).not.toBe(src);
    expect(strayDataPaths("fill-check-fetch.ts", byHand).length).toBeGreaterThan(0);
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
