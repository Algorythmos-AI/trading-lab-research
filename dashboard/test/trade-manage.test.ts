import { SERVER_SETTLE_MS } from "@/lib/trade-state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImInForm, ManageCard, readNotes, writeNotes } from "@/components/client/trade-manage";
import { focusOptions } from "@/lib/fixture-variants";
import { SCRIPT_ANSWER_LAG_MS, scriptBars, scriptQuote, stepInstant } from "@/lib/fixture-script";
import { focusPlan } from "@/lib/focus-plan";
import type { Lot } from "@/lib/journal";
import type { Options } from "@/lib/options";
import { altPlan, checkFill, hoursMin, manageView, type ManualNote, mmss, noteKey, openTrades, parseNotes } from "@/lib/trade-manage";
import optionsJson from "./fixtures/options.v1.json";

const E = focusOptions(optionsJson as unknown as Options, true);
const S = E.session; // 2026-10-12
const ITEMS = E.focus!.items;
const QQQ = ITEMS.find((i) => i.symbol === "QQQ")!;
const CALL = focusPlan(QQQ).call!;

const clock = (step: number) => stepInstant(S, step) + SCRIPT_ANSWER_LAG_MS + 1_000;
/** The note "I'm in" saves at step 3: QQQ's call at the live price, at the feed's clock. */
const note = (): ManualNote => ({ symbol: "QQQ", side: "call", price: scriptQuote("QQQ", S, 3)!.price, at: new Date(clock(3)).toISOString(), kind: "plan", plan: CALL });

function viewAt(step: number, notes: ManualNote[] = [note()], lots: Lot[] = [], paused = false) {
  const [t] = openTrades(ITEMS, lots, notes, S);
  return manageView(t!, { session: S, halfDay: false, quote: scriptQuote("QQQ", S, step), trail: [], serverBars: scriptBars("QQQ", S, step), serverFetchedAt: stepInstant(S, step) + SERVER_SETTLE_MS, now: clock(step), paused }); // the script's bars are final
}

describe("the manage card on the scripted morning", () => {
  it("holds right after the entry, with the 5-minute check counting down", () => {
    const v = viewAt(3);
    expect(v.action).toBe("hold");
    expect(v.line).toBe(`Holding: stop ${CALL.stop!.toFixed(2)} · target 1 ${CALL.target1!.toFixed(2)}`);
    expect(v.notWorkingText).toMatch(/^(5:00|4:5\d)$/);
    expect(v.trailText).toBe("after target 1");
    expect(v.flatAt).toBe("15:10");
    expect(v.flatText).toBe("4 h 42 min");
  });

  it("says target 1 hit: sell half, once QQQ runs past it", () => {
    const v = viewAt(4);
    expect(v.action).toBe("sell_half");
    expect(v.tone).toBe("good");
    expect(v.line).toBe(`Target 1 hit: sell half, stop to ${note().price.toFixed(2)}`);
    expect(v.m.stop).toBe(note().price);
    expect(v.notWorkingText).toBe("done");
  });

  it("says exit once a 2-min close falls under the stop moved to the entry", () => {
    const v = viewAt(5);
    expect(v.action).toBe("exit");
    expect(v.tone).toBe("bad");
    expect(v.line).toBe(`Below the stop ${note().price.toFixed(2)}: exit`);
    const html = renderToStaticMarkup(createElement(ManageCard, { v }));
    expect(html).toContain("bg-bad-soft");
    expect(html).toContain("EXIT");
  });

  it("with the prices paused says to manage on the platform", () => {
    const v = viewAt(3, [note()], [], true);
    expect(v.action).toBe("check");
    expect(v.line).toBe("Prices paused: manage this one on your platform");
  });
});

describe("where an open trade comes from", () => {
  const lot = (over: Partial<Lot> = {}): Lot => ({ symbol: "QQQ", kind: "call", strike: 753, expiry: S, side: "long", qty: 2, entry: 1.2, opened_at: new Date(clock(3)).toISOString(), ...over });

  it("reads the journal's open option lot on a focus name, with the card's entry as the price", () => {
    const [t] = openTrades(ITEMS, [lot()], [], S);
    expect(t).toMatchObject({ symbol: "QQQ", side: "call", entry: { source: "journal", price: CALL.entry } });
    const html = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(3, [], [lot()]) }));
    expect(html).toContain("In a trade · QQQ call");
    expect(html).toContain("From your Webull fills, up to 2 min behind; price levels from the card");
    expect(html).not.toContain("Clear");
  });

  it("leaves out shares, short lots, other names and other days", () => {
    expect(openTrades(ITEMS, [lot({ kind: "stock" }), lot({ side: "short" }), lot({ symbol: "NVDA" }), lot({ opened_at: "2026-10-09T15:00:00Z" })], [], S)).toEqual([]);
  });

  it("prefers the owner's note, which has the fill price", () => {
    const ts = openTrades(ITEMS, [lot()], [note()], S);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.entry.source).toBe("manual");
    const html = renderToStaticMarkup(createElement(ManageCard, { v: viewAt(3), onClear: () => {} }));
    expect(html).toContain("Your own note in this browser");
    expect(html).toContain("Clear");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\border\b/i);
  });

  it("manages a live alternative against its own entry, stop and 2:1 target", () => {
    const p = altPlan({ kind: "failed_break", side: "put", level: 779.4, stop: 780, entry: 779.1, at: 0 });
    expect(p).toMatchObject({ side: "put", entry: 779.1, stop: 780, target1: 777.3 });
  });
});

describe("the I'm in form", () => {
  it("takes a positive number within 5% of the live price", () => {
    expect(checkFill("753.43", 753.4)).toEqual({ ok: true, price: 753.43 });
    expect(checkFill(" 753.4 ", 753.4)).toEqual({ ok: true, price: 753.4 });
    expect(checkFill("", 753.4)).toMatchObject({ ok: false });
    expect(checkFill("abc", 753.4)).toMatchObject({ ok: false });
    expect(checkFill("-1", 753.4)).toEqual({ ok: false, error: "The price must be above 0" });
    expect(checkFill("800", 753.4)).toEqual({ ok: false, error: "That is more than 5% from the live price 753.40: check it" });
    expect(checkFill("715.8", 753.4)).toMatchObject({ ok: true });
  });

  it("starts with the live price, the side and the time, and never looks like an order", () => {
    const html = renderToStaticMarkup(createElement(ImInForm, { symbol: "QQQ", side: "call", live: 753.43, now: clock(3), onSave: () => {}, onCancel: () => {} }));
    expect(html).toContain('value="753.43"');
    expect(html).toContain("QQQ call");
    expect(html).toContain("10:28 New York");
    expect(html).toContain("Save note");
    expect(html).toContain("Nothing is sent anywhere");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\b(buy|sell|order|submit)\b/i);
  });
});

describe("the notes in this browser", () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = () => {
    const m = new Map<string, string>();
    return {
      m,
      ls: {
        get length() {
          return m.size;
        },
        key: (i: number) => [...m.keys()][i] ?? null,
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      },
    };
  };

  it("keeps a day's notes under that day's key and drops the other days'", () => {
    const { m, ls } = store();
    m.set(noteKey("2026-10-09"), "[]");
    vi.stubGlobal("window", { localStorage: ls, dispatchEvent: () => true });
    writeNotes(S, [note()]);
    expect([...m.keys()]).toEqual([noteKey(S)]);
    expect(parseNotes(readNotes(S))).toEqual([note()]);
    writeNotes(S, []);
    expect(m.size).toBe(0);
  });

  it("works for the page when storage throws, and with no storage at all", () => {
    const throwing = {
      get length(): number {
        throw new Error("denied");
      },
      getItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("window", { localStorage: throwing, dispatchEvent: () => true });
    writeNotes(S, [note()]);
    expect(parseNotes(readNotes(S))).toEqual([note()]);
    writeNotes(S, []);
    vi.stubGlobal("window", { dispatchEvent: () => true });
    expect(readNotes(S)).toBe("");
  });

  it("drops a malformed note, never throwing", () => {
    expect(parseNotes("not json")).toEqual([]);
    expect(parseNotes(JSON.stringify([{ symbol: "QQQ" }, { ...note(), price: -1 }, { ...note(), plan: { ...CALL, side: "put" } }]))).toEqual([]);
    expect(parseNotes(JSON.stringify([note(), note()]))).toHaveLength(1);
  });

  it("formats the countdown and the time to flat", () => {
    expect(mmss(299)).toBe("4:59");
    expect(mmss(5)).toBe("0:05");
    expect(hoursMin(286)).toBe("4 h 46 min");
    expect(hoursMin(12)).toBe("12 min");
    expect(hoursMin(0)).toBe("now");
  });
});
