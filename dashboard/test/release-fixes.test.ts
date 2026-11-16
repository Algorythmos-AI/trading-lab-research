import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fixtureDoc from "./fixtures/journal.v1.json";
import optionsJson from "./fixtures/options.v1.json";
import { ImInForm } from "@/components/client/trade-manage";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { toRows } from "@/components/journal";
import { JournalBody, TradesBody } from "@/components/trades-page";
import { focusOptions } from "@/lib/fixture-variants";
import { dayIn, shortDate, weekDate } from "@/lib/format";
import { isTrade, moneyView, parseFilter, readableJournal, sessionView, type JournalDoc, type Lot, type Trade } from "@/lib/journal";
import { listRows, packRow, pieceText, rowWords, unpackRow, whenText } from "@/lib/journal-list";
import { AccountHero } from "@/components/overview/home";
import { AccountRecentPanel } from "@/components/account-risk";
import { accountRisk } from "@/lib/account-risk";
import { dayJournal, journalDayCache, matchNotes, noteEntries } from "@/lib/manage-stop";
import { clockSwitches, sydneySession } from "@/lib/market-calendar";
import { nyClock, type Options } from "@/lib/options";
import { groupPieces, ownerPositions, R25_SHARE, SMALL_WIN_UNDER, tradeUnits } from "@/lib/owner-positions";
import { focusPlan } from "@/lib/focus-plan";
import { formFromRow, type ManualNote, openTrades, retiredNotes } from "@/lib/trade-manage";
import { boardDay } from "@/lib/trade-now";
import { dayCheck, PREMIUM_STOP, RAN_TO_MARK } from "@/lib/trade-rules";
import { dayFacts } from "@/lib/session-timeline";
import { tradesView } from "@/lib/trades-view";
import type { NameState } from "@/lib/trade-state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/trades",
  useSearchParams: () => new URLSearchParams(),
}));

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12
const doc = fixtureDoc as unknown as JournalDoc;

// ---- a journal the size of the owner's own -------------------------------------------------------------------------
const SYMS = ["SPY", "QQQ", "NVDA", "TSLA", "AAPL", "AMD"];
/** About 3,000 pieces from January 2023 to the session, two pieces a position, a few on the session itself. */
function bigJournal(pieces = 3000): JournalDoc {
  const trades: Trade[] = [];
  const start = Date.parse("2023-01-03T15:00:00Z");
  const end = Date.parse(`${S}T13:30:00Z`);
  const step = Math.floor((end - start) / (pieces / 2));
  for (let i = 0; trades.length < pieces - 4; i++) {
    const open = start + i * step;
    const sym = SYMS[i % SYMS.length]!;
    const kind = i % 3 === 0 ? "put" : "call";
    for (const half of [0, 1]) {
      trades.push({
        id: `b${i}-${half}`,
        symbol: sym,
        kind,
        strike: 400 + (i % 50),
        expiry: new Date(open).toISOString().slice(0, 10),
        side: "long",
        qty: 1,
        opened_at: new Date(open).toISOString(),
        closed_at: new Date(open + (5 + half * 4) * 60_000).toISOString(),
        entry: 1.2,
        exit: half ? 0.9 : 1.5,
        multiplier: 100,
        pnl: half ? -30 : 30,
        close: "order",
      });
    }
  }
  // The session's own: two QQQ calls this morning.
  for (const [k, hhmm] of [["s1", "14:20"], ["s2", "15:05"]] as const)
    trades.push({ id: k, symbol: "QQQ", kind: "call", strike: 750, expiry: S, side: "long", qty: 1, opened_at: `${S}T${hhmm}:00Z`, closed_at: `${S}T${hhmm.slice(0, 3)}50:00Z`, entry: 1.2, exit: 1.4, multiplier: 100, pnl: 20, close: "order" });
  return { ...doc, trades, open: [], gaps: [], money: null };
}

const BIG = bigJournal();
const LOTS: Lot[] = [{ symbol: "QQQ", kind: "call", strike: 750, expiry: S, side: "long", qty: 1, entry: 1.3, opened_at: `${S}T15:30:00Z` }];
const QQQ = E.focus!.items.find((i) => i.symbol === "QQQ")!;
const note = (hhmm: string): ManualNote => ({ symbol: "QQQ", side: "call", price: 750, at: `${S}T${hhmm}:00.000Z`, kind: "plan", plan: focusPlan(QQQ).call! });
const NOTES = [note("14:21"), note("15:31"), note("16:00")];

describe("the Options page's journal work (item 1)", () => {
  it("the generated journal is the owner's size", () => {
    expect(BIG.trades.length).toBeGreaterThanOrEqual(2998);
  });

  it("the server sends the browser only the session's pieces and the open lots", () => {
    const day = dayJournal(BIG.trades, LOTS, S);
    expect(day.closed.map((t) => t.id).sort()).toEqual(["s1", "s2"]);
    expect(day.lots).toEqual(LOTS);
    expect(JSON.stringify(day).length).toBeLessThan(JSON.stringify(BIG.trades).length / 100);
  });

  it("and the manage card reads the same from that day as from the whole history", () => {
    const day = dayJournal(BIG.trades, LOTS, S);
    expect(matchNotes(NOTES, day.closed, LOTS, S)).toEqual(matchNotes(NOTES, BIG.trades, LOTS, S));
    expect(openTrades(E.focus!.items, LOTS, NOTES, S, day.closed, `${S}T16:10:00Z`)).toEqual(openTrades(E.focus!.items, LOTS, NOTES, S, BIG.trades, `${S}T16:10:00Z`));
    expect(retiredNotes(NOTES, LOTS, day.closed, S, `${S}T16:10:00Z`)).toEqual(retiredNotes(NOTES, LOTS, BIG.trades, S, `${S}T16:10:00Z`));
  });

  it("a tick with the same inputs reads no row of the journal and returns the same objects", () => {
    const dayOf = vi.fn((iso: string) => nyClock(iso)?.day);
    const cache = journalDayCache(dayOf);
    const items = E.focus!.items;
    const asOf = `${S}T16:10:00Z`;
    const first = cache.match(NOTES, BIG.trades, LOTS, S);
    const trades = cache.openTrades(items, LOTS, NOTES, S, BIG.trades, asOf);
    const retired = cache.retired(NOTES, LOTS, BIG.trades, S, asOf);
    const calls = dayOf.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(BIG.trades.length); // the first render reads every row once
    for (let tick = 0; tick < 60; tick++) {
      expect(cache.match(NOTES, BIG.trades, LOTS, S)).toBe(first);
      expect(cache.openTrades(items, LOTS, NOTES, S, BIG.trades, asOf)).toBe(trades);
      expect(cache.retired(NOTES, LOTS, BIG.trades, S, asOf)).toBe(retired);
    }
    expect(dayOf.mock.calls.length).toBe(calls);
    // A new note re-matches the notes only: the journal's entries are kept.
    const more = [...NOTES, note("16:30")];
    cache.match(more, BIG.trades, LOTS, S);
    expect(dayOf.mock.calls.length - calls).toBe(more.length);
    expect(first).toEqual(matchNotes(NOTES, BIG.trades, LOTS, S));
    expect(noteEntries(BIG.trades, LOTS, S).length).toBe(3);
  });
});

// ---- formatters (item 1c) ----------------------------------------------------------------------------------------
describe("the shared date formatters (item 1c)", () => {
  const fresh = (iso: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
    const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
    return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
  };
  // New York's switches (8 Mar, 1 Nov 2026), Sydney's (5 Apr, 4 Oct 2026), and New York midnight in both offsets.
  const INSTANTS = [
    "2026-03-08T06:59:00Z", "2026-03-08T07:00:00Z", "2026-03-08T07:01:00Z",
    "2026-11-01T05:59:00Z", "2026-11-01T06:00:00Z", "2026-11-01T06:30:00Z",
    "2026-04-04T15:59:00Z", "2026-04-04T16:00:00Z", "2026-10-03T15:59:00Z", "2026-10-03T16:00:00Z",
    "2026-07-01T03:59:00Z", "2026-07-01T04:00:00Z", "2026-12-01T04:59:00Z", "2026-12-01T05:00:00Z", "2026-12-31T23:59:59Z",
  ];

  it("nyClock is byte-identical to a formatter built for the call, around the switches and midnight", () => {
    for (const iso of INSTANTS) expect(nyClock(iso)).toEqual(fresh(iso));
    expect(nyClock("2026-11-01T05:30:00Z")).toEqual({ day: "2026-11-01", minutes: 90 }); // 01:30 EDT
    expect(nyClock("2026-11-01T06:30:00Z")).toEqual({ day: "2026-11-01", minutes: 90 }); // 01:30 EST
    expect(nyClock("2026-07-01T04:00:00Z")).toEqual({ day: "2026-07-01", minutes: 0 });
    expect(nyClock("not a time")).toBeNull();
  });

  it("dayIn, shortDate, weekDate and the Sydney helpers say what a new formatter says", () => {
    for (const iso of INSTANTS) {
      expect(dayIn(iso, "America/New_York")).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)));
      expect(dayIn(iso, "Australia/Sydney")).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)));
    }
    expect(shortDate("2026-03-08")).toBe("8 Mar");
    expect(weekDate("2026-11-01")).toBe("Sun 1 Nov");
    expect(sydneySession("2026-10-12")).toEqual({ open: { weekday: "Tue", time: "00:30", day: "2026-10-13" }, close: { weekday: "Tue", time: "07:00", day: "2026-10-13" } });
    expect(clockSwitches(2026).map((c) => `${c.where} ${c.day}`)).toEqual(["New York 2026-03-08", "Sydney 2026-04-05", "Sydney 2026-10-04", "New York 2026-11-01"]);
  });

  it("builds no formatter per call", () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    for (const iso of INSTANTS) {
      nyClock(iso);
      dayIn(iso, "America/New_York");
    }
    shortDate("2026-03-08");
    weekDate("2026-03-08");
    sydneySession("2026-10-12");
    clockSwitches(2027);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---- iOS zoom (item 3) ---------------------------------------------------------------------------------------------
describe("form fields on a phone are 16 px (item 3)", () => {
  const under16 = (cls: string) => /(^|\s)text-(\[0\.\d+rem\]|xs|sm)(\s|$)/.test(cls) && !/(^|\s)max-sm:text-base(\s|$)/.test(cls);
  it("every field of the note form", () => {
    const state = { symbol: "QQQ", state: "enter_zone", side: "call", alt: null } as unknown as NameState;
    const f = formFromRow("QQQ", state, QQQ, Date.parse(`${S}T14:30:00Z`))!;
    const html = renderToStaticMarkup(createElement(ImInForm, { f, live: 750, now: Date.parse(`${S}T14:30:00Z`), session: S, halfDay: false, onSave: () => {}, onCancel: () => {} }));
    const fields = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*class="([^"]*)"/g)].map((m) => m[1]!);
    expect(fields.length).toBe(4);
    expect(fields.filter(under16)).toEqual([]);
  });

  it("the contract picker's fields", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/components/client/options-contract.tsx", import.meta.url)), "utf8");
    expect(under16(src.match(/const FIELD = "([^"]*)"/)![1]!)).toBe(false);
  });
});

// ---- malformed rows (item 6) ---------------------------------------------------------------------------------------
const piece = doc.trades[0]!;
const MALFORMED: [string, Partial<JournalDoc>][] = [
  ["a piece with no opened_at", { trades: [...doc.trades, { ...piece, id: "bad", opened_at: undefined } as unknown as Trade] }],
  ["a null piece", { trades: [null as unknown as Trade, ...doc.trades] }],
  ["a null in gaps", { gaps: [null as unknown as NonNullable<JournalDoc["gaps"]>[number], ...(doc.gaps ?? [])] }],
  ["money without transfers", { money: { ...(doc.money ?? { currency: "AUD", as_of: doc.as_of }), transfers: undefined } as unknown as JournalDoc["money"] }],
  ["a bad open lot", { open: [{ symbol: "QQQ" } as unknown as Lot, ...(doc.open ?? [])] }],
];
const now = new Date("2026-10-16T20:00:00Z");

describe("a row that cannot be read is left out, not thrown on (item 6)", () => {
  for (const [what, change] of MALFORMED) {
    it(`the Trades page draws with ${what}`, () => {
      const bad = { ...doc, ...change } as JournalDoc;
      const r = readableJournal(bad);
      expect(r.skipped).toBe(1);
      expect(() => tradesView(bad, parseFilter({}), now)).not.toThrow();
      expect(() => groupPieces(bad.trades)).not.toThrow();
      const html = renderToStaticMarkup(createElement(TradesBody, { result: { status: "ok", doc: bad, source: "fixture" }, clone: { status: "missing" }, q: {}, now }));
      expect(html).toContain("1 row could not be read and is left out.");
      expect(html).toContain('id="record"');
      expect(html).toContain('id="clone"');
    });

    it(`the Options page's journal work runs with ${what}`, () => {
      const d = readableJournal({ ...doc, ...change } as JournalDoc).doc;
      const n2 = new Date(`${S}T15:00:00Z`);
      expect(() => boardDay(d, n2)).not.toThrow();
      expect(() => dayFacts(dayCheck(sessionView(d, n2), { asOf: d.as_of, now: n2 }), d.as_of, n2, d.open ?? [])).not.toThrow();
      const raw = { ...doc, ...change } as JournalDoc;
      expect(() => dayJournal(raw.trades, raw.open, S)).not.toThrow();
      expect(() => matchNotes(NOTES, dayJournal(raw.trades, raw.open, S).closed, [], S)).not.toThrow();
    });
  }

  it("counts a missing piece once, in tradesView too, and keeps a whole journal as it is", () => {
    expect(tradesView({ ...doc, trades: [...doc.trades, { id: "x" } as unknown as Trade] }, parseFilter({}), now).skipped).toBe(1);
    expect(readableJournal(doc)).toEqual({ doc, skipped: 0 });
    expect(doc.trades.every(isTrade)).toBe(true);
  });

  it("moneyView skips a transfer or value it cannot read, and a block without transfers reads as none", () => {
    const m = { currency: "AUD", as_of: doc.as_of, transfers: [{ date: "2026-01-02", amount: 100, source: "statement" }, null, { date: "2026-01-03" }], values: [null, { date: "2026-01-02", value: 90 }] } as unknown as NonNullable<JournalDoc["money"]>;
    const v = moneyView(m, 0);
    expect([v.deposits, v.skipped, v.series.length]).toEqual([100, 3, 1]);
    expect(moneyView({ currency: "AUD", as_of: doc.as_of } as unknown as NonNullable<JournalDoc["money"]>, 0).skipped).toBe(1);
  });

  it("each journal group sits behind a pane boundary of its own", () => {
    const tree = JournalBody({ doc, q: {}, now }) as ReactElement;
    const names: string[] = [];
    const walk = (n: ReactNode) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement(n)) return;
      const p = n.props as { name?: string; children?: ReactNode };
      if (n.type === PaneBoundary) names.push(p.name!);
      walk(p.children);
    };
    walk(tree);
    expect(names).toEqual(["Today", "The record", "History"]);
  });
});

// ---- the Trades page's words (items 5, 7, 8) ------------------------------------------------------------------------
describe("the Trades page's words", () => {
  const html = renderToStaticMarkup(createElement(TradesBody, { result: { status: "ok", doc, source: "fixture" }, clone: { status: "missing" }, q: {}, now }));
  it("the money line says the picks do not apply, the value is the broker's, and only the quoted trades total is before fees", () => {
    expect(html).not.toContain("and it is before fees");
    expect(html).toContain("the picks above do not apply to it");
    expect(html).toContain("broker&#x27;s own figure");
    expect(html).toContain("only the closed-trades total quoted under the chart is before fees");
    expect(html).not.toContain("by a cent");
    expect(html.match(/money panel are before fees/g)).toBeNull();
  });

  it("shows the clone's title once: the group heading is for a screen reader only", () => {
    expect(html).toMatch(/<h2 id="clone-group-title" data-group-heading="hidden" class="[^"]*sr-only[^"]*">Options clone \(paper\)<\/h2>/);
    expect(html).toContain('id="clone"');
  });

  it("one stop share, and two win lines named for what they mean", () => {
    expect(R25_SHARE).toBe(PREMIUM_STOP);
    expect([RAN_TO_MARK, SMALL_WIN_UNDER]).toEqual([0.2, 0.5]);
    expect(html).toContain("Winners closed under +50% on premium");
  });
});

// ---- the list's payload (item 9) -----------------------------------------------------------------------------------
describe("every trade, packed for the browser (item 9)", () => {
  const units = tradeUnits(BIG.trades, { basis: "net", feesIncluded: false });
  const rows = toRows(units);
  const packed = rows.map(packRow);

  it("is far smaller than the rows with their pieces in words", () => {
    // Before: the rows as they were sent, each piece as its id and its words.
    const before = JSON.stringify(rows.map((r) => ({ ...r, pieces: r.pieces.map(({ id, text }) => ({ id, text })) }))).length;
    const after = JSON.stringify(packed).length;
    // Printed for the release notes: the sizes with a 3,000-piece journal.
    console.info(`journal table props: ${before} bytes as rows, ${after} packed`);
    expect(after).toBeLessThan(before * 0.6);
  });

  it("says, sorts and finds exactly what the rows did", () => {
    const back = packed.map(unpackRow);
    for (let i = 0; i < rows.length; i += 97) {
      expect(back[i]!.words).toEqual(rowWords(rows[i]!));
      expect(back[i]!.pieces.map(pieceText)).toEqual(rows[i]!.pieces.map((p) => p.text));
    }
    for (const [q, only, sort] of [["", "all", { key: "at", dir: -1 }], ["qqq", "win", { key: "pnl", dir: 1 }], ["oct", "loss", { key: "holdMin", dir: -1 }]] as const)
      expect(listRows(back, q, only, sort).map((r) => r.id)).toEqual(listRows(rows, q, only, sort).map((r) => r.id));
    const fx = toRows(ownerPositions(doc).positions.length ? tradeUnits(doc.trades, { basis: "net" }) : []);
    expect(fx.filter((r) => r.expired).map(packRow).every((p) => unpackRow(p).expired)).toBe(true);
  });
});

// ---- review nits ----------------------------------------------------------------------------------------------------
describe("the piece's date, the same in every engine", () => {
  it("writes our own short month names, never the engine's", () => {
    expect(whenText(Date.parse("2026-09-16T19:30:00Z"))).toBe("16 Sep 26 · 15:30");
    expect(whenText(Date.parse("2026-06-01T04:05:00Z"))).toBe("1 Jun 26 · 00:05"); // New York midnight, as 00
    expect(whenText(Date.parse("2026-11-01T06:30:00Z"))).toBe("1 Nov 26 · 01:30"); // the hour repeated at the switch
    expect(whenText(Date.parse("2023-01-03T15:00:00Z"))).toBe("3 Jan 23 · 10:00");
    expect(pieceText({ qty: 1, entry: 0.6, exit: 0.75, closedAt: Date.parse("2026-09-16T19:30:00Z"), pnl: 15 })).toBe("1 × 0.60 → 0.75, sold 16 Sep 26 · 15:30: +⁠$15.00 before fees");
  });
});

describe("money in and out with a transfer that cannot be read, on the Overview and the Risk page", () => {
  const bad = { ...doc, money: { ...(doc.money ?? { currency: "AUD", as_of: doc.as_of }), transfers: [...(doc.money?.transfers ?? []), null] } } as unknown as JournalDoc;
  it("the Overview's account says so where its money figures show", () => {
    const html = renderToStaticMarkup(createElement(AccountHero, { doc: bad, now }));
    expect(html).toContain("Money in and out: 1 row could not be read and is left out.");
    expect(renderToStaticMarkup(createElement(AccountHero, { doc, now }))).not.toContain("could not be read");
  });
  it("and the Risk page's account panel", () => {
    const m = moneyView(bad.money!, 0);
    const html = renderToStaticMarkup(createElement(AccountRecentPanel, { r: accountRisk(bad, now), money: m }));
    expect(html).toContain("Money in and out: 1 row could not be read and is left out.");
  });
});
