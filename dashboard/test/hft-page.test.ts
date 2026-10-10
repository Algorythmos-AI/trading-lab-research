// The HFT page without a browser: what a reader would see, as text, before the desk has published and after.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HftBooks, HftLearning, HftPairs, HftPhases, HftRecorder, HftSleeves, HftStatus, NoHftSnapshot } from "@/components/hft/panels";
import { DESK_PATHS } from "@/lib/desk";
import { freshness } from "@/lib/freshness";
import { hftHealth, look, megabytes, net, phaseLine, phases, spread, words, MODE, SLEEVE_STAGE, type Hft } from "@/lib/hft";
import { makeFakeBlobSdk } from "./blob-sdk";

const sdk = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeFakeBlobSdk> }));
vi.mock("@vercel/blob", async () => {
  const { makeFakeBlobSdk: make } = await import("./blob-sdk");
  sdk.current = make();
  return sdk.current;
});

const { default: HftPage } = await import("@/app/hft/page");
const { HFT_NAV, CRYPTO_NAV, NAV } = await import("@/components/client/nav-tabs");

const fixture = (): Hft => JSON.parse(readFileSync(new URL("./fixtures/hft.v1.json", import.meta.url), "utf8")) as Hft;
const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const page = async () => renderToString(await HftPage());

beforeEach(() => {
  sdk.current.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("DASHBOARD_FIXTURE", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("the HFT desk's sections", () => {
  it("has one section for now, and the other desks' sections are as they were", () => {
    expect(HFT_NAV).toEqual([{ href: "/hft", label: "Overview" }]);
    expect(NAV.map((n) => n.href)).toEqual(["/", "/today", "/radar", "/options", "/strategies", "/research", "/operations", "/risk", "/engineering"]);
    expect(CRYPTO_NAV.map((n) => n.href)).toEqual([
      "/crypto", "/crypto/market", "/crypto/strategy", "/crypto/research", "/crypto/learning", "/crypto/operations", "/crypto/risk", "/crypto/engineering",
    ]);
  });
});

describe("the HFT page before the desk has published", () => {
  it("is a composed empty state: what the desk is, that it has not published, and when the page fills in", async () => {
    const html = await page();
    const out = text(html);
    expect(html).toMatch(/<h1[^>]*>HFT<\/h1>/);
    expect(out).toContain("a separate platform");
    expect(out).toContain("trades currencies on a broker paper account, fully automatically");
    expect(out).toContain("The HFT desk has not published yet");
    expect(out).toContain("This page fills in when the desk's recorder starts");
    expect(out).toContain("What this page will show");
    expect(out).not.toMatch(/could not be read|error|failed/i);
  });

  it("shows nothing that looks like a reading: no number but the names of the phases, no dash, no status, no table", async () => {
    const html = await page();
    const out = text(html).replace("F0 to F7", "");
    expect(out).not.toMatch(/\d/);
    expect(out).not.toContain("—");
    expect(out).not.toMatch(/All clear|Needs a look|Action needed|Status (green|amber|red)/);
    expect(html).not.toMatch(/<table|data-slot="badge"|role="status"/);
  });

  it("says so when storage cannot be read, without the list of what is to come", async () => {
    sdk.current.write(DESK_PATHS.hft.latest, "[]");
    const out = text(await page());
    expect(out).toContain("Storage could not be read");
    expect(out).not.toContain("has not published yet");
    expect(text(renderToString(createElement(NoHftSnapshot, { status: "error" })))).toContain("It retries every minute");
  });
});

describe("the HFT page with a snapshot", () => {
  const stored = (s: Hft) => sdk.current.write(DESK_PATHS.hft.latest, JSON.stringify(s));

  it("draws every section from the stored snapshot, headings in order", async () => {
    stored(fixture());
    const html = await page();
    const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => `h${m[1]} ${text(m[2]!).trim()}`);
    expect(headings[0]).toBe("h1 HFT");
    expect(headings.slice(2)).toEqual(["h2 Build phases", "h2 Recorder", "h2 Pairs", "h2 Sleeves", "h2 Books", "h3 Shadow book", "h3 Broker book", "h2 Learning"]);
    expect(headings[1]).toMatch(/^h2 (All clear|Needs a look|Action needed)$/); // the health banner; its level depends on the clock
    expect(headings.filter((h) => h.startsWith("h1"))).toHaveLength(1);
    const out = text(html);
    expect(out).not.toMatch(/NaN|undefined|Infinity|\[object/);
    expect(out).not.toContain("has not published yet");
  });

  it("says each status in words", () => {
    const out = text(renderToString(createElement(HftStatus, { s: fixture() })));
    for (const part of ["Mode Paper", "Stage Shadow", "Venue IBKR paper", "Market Open", "Kill switch Off", "Flatten switch: off."]) expect(out).toContain(part);
    const s = fixture();
    s.desk.market_open = false;
    s.desk.kill = true;
    s.desk.flatten = true;
    const closed = text(renderToString(createElement(HftStatus, { s })));
    for (const part of ["Market Closed", "Kill switch On", "Flatten switch: on."]) expect(closed).toContain(part);
  });

  it("draws the phases F0 to F7 in order with each state in words, however the desk ordered them", () => {
    const s = fixture();
    s.phases.reverse();
    const out = text(renderToString(createElement(HftPhases, { s })));
    expect(out).toContain("F0 Done F1 Done F2 Done F3 Now F4 Not yet F5 Not yet F6 Not yet F7 Not yet");
    expect(out).toContain("3 of 8 phases are done. F3 is open.");
  });

  it("draws the recorder, with the last event as a time", () => {
    const html = renderToString(createElement(HftRecorder, { s: fixture() }));
    const out = text(html);
    for (const part of ["State Running", "Events today 398,740", "Unexplained gaps today 0", "Disk used 1,844 MB"]) expect(out).toContain(part);
    // the server writes the UTC wall time; the browser turns it into "12 min ago"
    expect(html).toMatch(/<time dateTime="2026-10-09T14:29:59\+00:00"[^>]*>Fri 9 Oct, 14:29 UTC<\/time>/);
    const s = fixture();
    s.recorder!.gaps_unexplained_today = 3;
    expect(renderToString(createElement(HftRecorder, { s }))).toMatch(/data-slot="badge"[^>]*>(<svg[\s\S]*?<\/svg>)?3</);
  });

  it("draws the pairs and the sleeves as tables with column headers", () => {
    const pairs = renderToString(createElement(HftPairs, { s: fixture() }));
    expect([...pairs.matchAll(/<th[^>]*scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(["Pair", "Form", "Last quote", "Updates a second", "Median spread"]);
    expect(text(pairs)).toContain("EUR.USD Cash Fri 9 Oct, 14:29 UTC 4.2 0.00008");
    expect(text(pairs)).toContain("USD.JPY Cash Fri 9 Oct, 14:29 UTC 3.6 0.011");
    expect(pairs).toMatch(/role="region" aria-label="Currency pairs" tabindex="0"/);
    const sleeves = renderToString(createElement(HftSleeves, { s: fixture() }));
    expect([...sleeves.matchAll(/<th[^>]*scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual([
      "Sleeve", "Stage", "Trades today", "Trades in total", "Net today", "Net in total",
    ]);
    expect(text(sleeves)).toContain("Control Shadow 6 41 −3.20 USD +12.85 USD");
    expect(text(sleeves)).toContain("Directional change Shadow 9 57 +5.40 USD −8.10 USD");
  });

  it("draws the two books side by side, the break count, and the caption that the shadow book is the result of record", () => {
    const out = text(renderToString(createElement(HftBooks, { s: fixture() })));
    expect(out).toContain("Shadow book The desk's own count Net today +2.20 USD Net in total +4.75 USD");
    expect(out).toContain("Broker book The broker's count Net today 0.00 USD Net in total 0.00 USD");
    expect(out).toContain("Reconciliation breaks today None");
    expect(out).toContain("Open positions 1");
    expect(out).toContain("The shadow book is the result of record.");
    const s = fixture();
    s.books!.reconciliation_breaks_today = 2;
    expect(text(renderToString(createElement(HftBooks, { s })))).toContain("Reconciliation breaks today 2");
  });

  it("draws learning, and a rollback that never happened as a dash", () => {
    const out = text(renderToString(createElement(HftLearning, { s: fixture() })));
    expect(out).toContain("Champion dc_2026w39.r1");
    expect(out).toContain("Challengers 1");
    expect(out).toContain("Last training Sun 4 Oct, 02:00 UTC");
    expect(out).toContain("Last promotion Sun 27 Sept, 02:10 UTC");
    expect(out).toContain("Last rollback —");
  });

  it("gives every optional section the standard nothing-yet treatment when it is absent or null", async () => {
    const s = fixture();
    delete s.recorder;
    delete s.pairs;
    s.sleeves = null;
    s.books = null;
    delete s.learning;
    s.phases = [];
    stored(s);
    const html = await page();
    const out = text(html);
    for (const title of ["No build phases reported yet", "No recorder status yet", "No pairs yet", "No sleeves yet", "No books yet", "No learning status yet"]) {
      expect(out, title).toContain(title);
    }
    // the sections keep their headings, and nothing is drawn as a zero
    for (const h of ["Build phases", "Recorder", "Pairs", "Sleeves", "Books", "Learning"]) expect(out).toContain(h);
    expect(html).not.toMatch(/<table/);
    expect(out).not.toMatch(/NaN|undefined|\[object/);
  });

  it("draws a stored snapshot this build does not fully know without failing", () => {
    const s = fixture() as unknown as Record<string, Record<string, unknown>>;
    s.desk!.stage = "live_candidate";
    (s.sleeves as unknown as Record<string, unknown>[])[0]!.stage = "constructor";
    (s.phases as unknown as Record<string, unknown>[])[0]!.state = "toString";
    const odd = s as unknown as Hft;
    expect(text(renderToString(createElement(HftStatus, { s: odd })))).toContain("Stage live_candidate");
    expect(text(renderToString(createElement(HftSleeves, { s: odd })))).toContain("Control constructor");
    expect(text(renderToString(createElement(HftPhases, { s: odd })))).toContain("F0 Not yet");
  });
});

describe("HFT health", () => {
  const WINDOW = [{ session: "2026-W41", start: "2026-10-04T21:00:00+00:00", end: "2026-10-09T21:00:00+00:00" }];
  const at = (s: Hft, iso: string) => hftHealth(s, freshness(s.as_of, WINDOW, Date.parse(iso)));
  const FRESH = "2026-10-09T14:35:00Z";

  it("is the desk's own level, with the desk's reason codes as it sent them", () => {
    expect(at(fixture(), FRESH)).toMatchObject({ level: "green", reasons: [] });
    const warn = fixture();
    warn.health = { level: "warn", reasons: ["recorder:gap", "quotes_slow"] };
    expect(at(warn, FRESH).level).toBe("amber");
    expect(at(warn, FRESH).reasons).toEqual([
      { code: "desk:recorder:gap", level: "amber", text: "The desk reports: recorder:gap." },
      { code: "desk:quotes_slow", level: "amber", text: "The desk reports: quotes_slow." },
    ]);
    const bad = fixture();
    bad.health = { level: "bad", reasons: ["books:break", "books:break"] };
    expect(at(bad, FRESH)).toMatchObject({ level: "red", reasons: [{ code: "desk:books:break", level: "red" }] });
  });

  it("never reads green when the desk says warn or bad, even with no reason code", () => {
    const warn = fixture();
    warn.health = { level: "warn", reasons: [] };
    expect(at(warn, FRESH)).toMatchObject({ level: "amber", reasons: [{ code: "desk", text: "The desk reports a warning and gave no reason code." }] });
    const bad = fixture();
    bad.health = { level: "bad", reasons: [] };
    expect(at(bad, FRESH)).toMatchObject({ level: "red", reasons: [{ code: "desk", text: "The desk reports a problem and gave no reason code." }] });
  });

  it("adds what the dashboard sees from outside: late, stopped, and the kill and flatten switches", () => {
    expect(at(fixture(), "2026-10-09T15:10:00Z").reasons.map((r) => r.code)).toEqual(["late"]); // 40 min old, in the window
    expect(at(fixture(), "2026-10-09T16:10:00Z")).toMatchObject({ level: "red", reasons: [{ code: "stopped" }] });
    expect(at(fixture(), "2026-10-10T16:10:00Z")).toMatchObject({ level: "green" }); // Saturday: outside the window, not late
    const s = fixture();
    s.desk.kill = true;
    s.desk.flatten = true;
    expect(at(s, FRESH)).toMatchObject({ level: "amber", reasons: [{ code: "kill" }, { code: "flatten" }] });
    const both = fixture();
    both.health = { level: "warn", reasons: ["quotes_slow"] };
    expect(at(both, "2026-10-09T16:10:00Z").reasons.map((r) => [r.level, r.code])).toEqual([["red", "stopped"], ["amber", "desk:quotes_slow"]]);
    expect(new Set(at(both, "2026-10-09T16:10:00Z").reasons.map((r) => r.code)).size).toBe(2); // the banner keys its list by code
  });
});

describe("HFT formatting", () => {
  it("shows a net result with its sign and currency, and a missing one as a dash", () => {
    expect([net(2.2, "USD"), net(-3.2, "USD"), net(0, "USD"), net(null, "USD"), net(1.5, null)]).toEqual(["+2.20 USD", "−3.20 USD", "0.00 USD", "—", "+1.50"]);
  });

  it("shows a small spread as a number, not as zero", () => {
    expect([0.00008, 0.011, 1.23456, 0, null].map(spread)).toEqual(["0.00008", "0.011", "1.23", "0", "—"]);
    expect([megabytes(1843.5), megabytes(0), megabytes(null)]).toEqual(["1,844 MB", "0 MB", "—"]);
  });

  it("orders the phases and counts them in English", () => {
    const s = fixture();
    s.phases = [{ id: "F2", state: "open" }, { id: "F0", state: "done" }, { id: "F1", state: "open" }];
    expect(phases(s).map((p) => p.id)).toEqual(["F0", "F1", "F2"]);
    expect(phaseLine(phases(s))).toBe("1 of 3 phases are done. F1, F2 are open.");
    expect(phaseLine([{ id: "F0", state: "done" }])).toBe("1 of 1 phase is done.");
  });

  it("shows an id it has no words for as the id, and never something the id merely happens to name", () => {
    expect([words(MODE, "paper"), words(MODE, "live"), words(MODE, "constructor"), words(MODE, null)]).toEqual(["Paper", "live", "constructor", "—"]);
    expect(look(SLEEVE_STAGE, "stepped_down")).toEqual({ label: "Stepped down", tone: "warn" });
    expect(look(SLEEVE_STAGE, "toString")).toEqual({ label: "toString", tone: "neutral" });
  });
});
