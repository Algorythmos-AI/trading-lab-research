// What Gap Hunter is doing now (DEC-0078, lib/gap-hunter-now.ts) and the page's live panels, on the fixture's states.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GapHunterBody } from "@/components/gap-hunter/gap-hunter-page";
import { fixtureGapLive, FROZEN_NOW, type VariantFlag } from "@/lib/fixture-variants";
import type { GapHunterLive } from "@/lib/gap-hunter-live.types";
import { clockAt, dayRail, freshnessOf, hero, ladder, orders, pickSource, readLive, results, rAt, ruleWords, stopRuleProgress } from "@/lib/gap-hunter-now";
import type { GapHunterLiveResult } from "@/lib/snapshot";
import type { Snapshot } from "@/lib/types";
import { fixtureV3 } from "./helpers";

const NOW = new Date(FROZEN_NOW); // Monday 12 Oct 2026, 11:01 New York
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

function liveDoc(...flags: VariantFlag[]): GapHunterLive {
  const s = fixtureV3() as unknown as { gap_hunter: GapHunterLive["gap_hunter"] };
  const doc: GapHunterLive = { schema: "stocksdelta/gap-hunter-live", schema_version: 1, run_id: "r", as_of: String(s.gap_hunter.as_of), paper: true, gap_hunter: structuredClone(s.gap_hunter) };
  return fixtureGapLive(doc, new Set(flags));
}
const ok = (d: GapHunterLive): GapHunterLiveResult => ({ status: "ok", doc: d, source: "fixture" });
const live = (...flags: VariantFlag[]) => readLive(pickSource(fixtureV3(), ok(liveDoc(...flags))).raw)!;
const page = (l: GapHunterLiveResult | null, s: Snapshot | null = fixtureV3()) => text(renderToStaticMarkup(createElement(GapHunterBody, { s, now: NOW, live: l })));

describe("which copy of the block", () => {
  it("takes the newer of the snapshot's and the live document's, by the block's own as_of", () => {
    const s = fixtureV3();
    expect(pickSource(s, ok(liveDoc("gap-watch"))).from).toBe("live");
    const old = liveDoc();
    old.gap_hunter.as_of = "2026-10-01T14:00:00+00:00";
    expect(pickSource(s, ok(old)).from).toBe("snapshot");
    expect(pickSource(s, { status: "missing" }).from).toBe("snapshot");
    expect(pickSource(null, null)).toMatchObject({ from: "none", raw: null });
  });

  it("calls the live copy late after 3 minutes and the snapshot's after 12, only in the publish window", () => {
    const s = fixtureV3();
    expect(freshnessOf(pickSource(s, ok(liveDoc("gap-watch"))), NOW).state).toBe("fresh");
    expect(freshnessOf(pickSource(s, ok(liveDoc("gap-stale"))), NOW).state).toBe("stopped");
    const snapOnly = { ...pickSource(s, null), asOf: new Date(NOW.getTime() - 10 * 60_000).toISOString() };
    expect(freshnessOf(snapOnly, NOW).state).toBe("fresh");
    expect(freshnessOf(snapOnly, new Date("2026-10-12T23:00:00Z")).state).toBe("asleep");     // 19:00 New York
    expect(freshnessOf(snapOnly, new Date("2026-10-10T15:00:00Z")).state).toBe("asleep");     // a Saturday
  });

  it("knows a half day closes at 13:00, so its window ends at 13:15", () => {
    expect(clockAt(new Date("2026-11-27T18:14:00Z")).inWindow).toBe(true);
    expect(clockAt(new Date("2026-11-27T18:16:00Z")).inWindow).toBe(false);
    expect(clockAt(new Date("2026-11-26T15:00:00Z")).inWindow).toBe(false);                   // Thanksgiving
  });
});

describe("the block, read field by field", () => {
  it("drops what is not a symbol, a code or a number", () => {
    const l = readLive({ pick: { symbol: "not a symbol", tier2: ["AAAA", "a b", 3] }, rules: [{ rule: "setup", why: "ok" }, { rule: "e2", why: "Free Text" }], timeline: [{ t: "x", event: "armed" }] })!;
    expect(l.pick).toEqual({ symbol: null, rank: null, why: null, tier2: ["AAAA"] });
    expect(l.rules).toEqual([{ rule: "e2", why: null, trigger: null, stop: null }]);
    expect(l.timeline).toEqual([]);
    expect(readLive(null)).toBeNull();
  });

  it("tells the traded rotation (HYP-0072) from its shadow, and keeps how it ended as a code", () => {
    expect(readLive({ rotation: { names: 3, changes: 2, live: true, done: "attempt" } })!.rotation).toEqual({ names: 3, changes: 2, live: true, done: "attempt" });
    expect(readLive({ rotation: { names: 3, changes: 1, done: "Free Text" } })!.rotation).toEqual({ names: 3, changes: 1, live: false, done: null });
    const traded = liveDoc("gap-watch");
    traded.gap_hunter.rotation = { names: 3, changes: 2, live: true, done: "no_signal" };
    expect(page(ok(traded))).toContain("Rotation (HYP-0072, trading): 3 names watched, 2 changes, ended: no signal.");
    const shadow = liveDoc("gap-watch");
    shadow.gap_hunter.rotation = { names: 3, changes: 1, done: null };
    expect(page(ok(shadow))).toContain("Rotation shadow (counts only, not traded): 3 names watched, 1 changes.");
  });

  it("says a rule's state, never what it looks for, and shows an unknown code as itself", () => {
    expect(ruleWords("ok").words).toBe("Order ready");
    expect(ruleWords("closed").words).toBe("Window over");
    expect(ruleWords("brand_new").words).toBe("brand_new");
    expect(ruleWords(null).words).toBe("No answer this minute");
  });
});

describe("now, in one sentence", () => {
  const c = clockAt(NOW);
  it("in a trade: shares, what sold at the target, the stop and target with their R", () => {
    const inTrade = readLive(pickSource(fixtureV3(), ok(liveDoc("gap-stale"))).raw)!;
    const t = hero(inTrade, c);
    expect(t).toMatchObject({ word: "In a trade", tone: "info", symbol: "AAAA" });
    expect(t.line).toContain("46 shares, 23 sold at the first target on e2");
    expect(t.line).toContain("Stop 5.07 (0.00R if hit), target 5.33 (+2.00R)");
  });

  it("an order resting is not a holding", () => {
    expect(hero(live("gap-resting"), c)).toMatchObject({ word: "Order resting", symbol: "AAAA" });
  });

  it("a held trade from an earlier session is a warning", () => {
    expect(hero(readLive(pickSource(fixtureV3(), ok(liveDoc())).raw), c)).toMatchObject({ word: "Holding from an earlier session", tone: "warn" });
  });

  it("watching, no pick, done for the day and latched", () => {
    expect(hero(live("gap-watch"), c).line).toContain("e2 has an order ready");
    expect(hero(live("gap-nopick"), c)).toMatchObject({ word: "No pick today" });
    expect(hero(live("gap-nopick"), c).line).toContain("no name passed every filter");
    expect(hero(live("gap-flat"), c)).toMatchObject({ word: "Done for the day" });
    expect(hero(live("gap-flat"), c).line).toContain("1 trade today, +0.50R on paper");
    expect(hero(live("gap-latched"), c)).toMatchObject({ word: "Stopped by its safety rules", tone: "bad" });
    expect(hero(null, c).word).toBe("Not sent yet");
  });
});

describe("the day, the ladder, the orders and the results", () => {
  it("draws the day as steps, with the next one marked now", () => {
    const watch = dayRail(live("gap-watch"), () => "t");
    expect(watch.map((s) => s.state)).toEqual(["done", "done", "current", "todo", "todo", "todo", "todo"]);
    const flat = dayRail(live("gap-flat"), () => "t");
    expect(flat.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "done", "done"]);
    expect(dayRail(live("gap-nopick"), () => "t")[1]).toMatchObject({ state: "failed", words: "None" });
  });

  it("puts the prices top to bottom with their R, the first stop kept below a moved one", () => {
    const p = live("gap-stale").position!;
    expect(ladder(p).map((r) => [r.key, r.price, r.r === null ? null : Number(r.r.toFixed(2))])).toEqual([
      ["target", 5.33, 2],
      ["entry", 5.07, 0],
      ["stop", 5.07, 0],
      ["stop0", 4.94, -1],
    ]);
    expect(rAt({ ...p, stop0: p.entry }, 5.2)).toBeNull();                                      // no risk, no R
    expect(ladder(live("gap-resting").position).map((r) => r.key)).toEqual(["target", "trigger", "stop"]);
  });

  it("lists order activity from the timeline, and totals booked trades with their haircuts", () => {
    expect(orders(live("gap-flat")).map((o) => o.what)).toEqual(["Entry order placed", "Entry filled", "Sold part at the first target", "Stop moved", "Trade closed"]);
    expect(results(live("gap-flat"))).toMatchObject({ trades: 2, wins: 1 });
    expect(results(live("gap-flat")).sumR).toBeCloseTo(-0.55);
    expect(results(live("gap-flat")).sumH2).toBeCloseTo(-1.15);
    expect(stopRuleProgress(live("gap-flat").stopRule)).toEqual({ trades: 1 / 30, loss: 1.05 / 6 });
  });
});

describe("the page", () => {
  it("shows the live state, the position ladder, the rules, the timeline, the brakes and the closed trades", () => {
    const body = page(ok(liveDoc("gap-stale")));
    expect(body).toContain("In a trade");
    expect(body).toContain("Not updating");                                                   // 20 minutes old in session
    expect(body).toMatch(/First target\s+5\.33\s+\+2\.00R/);
    expect(body).toContain("Order ready");
    expect(body).toContain("Sold part at the first target");
    expect(body).toContain("Trades toward the review at 30");
    expect(body).toContain("−1.05R of −6.00R");
    expect(body).toContain("How Gap Hunter works");
    expect(body).toContain("Paper money only");
  });

  it("works from the snapshot alone before the live document is installed", () => {
    const body = page({ status: "missing" });
    expect(body).toContain("every 5 minutes");
    expect(body).toContain("Holding from an earlier session");
  });

  it("shows each state's words", () => {
    expect(page(ok(liveDoc("gap-watch")))).toContain("Watching");
    expect(page(ok(liveDoc("gap-resting")))).toContain("Order resting");
    expect(page(ok(liveDoc("gap-flat")))).toContain("Done for the day");
    expect(page(ok(liveDoc("gap-latched")))).toContain("Latched: X3");
    expect(page(ok(liveDoc("gap-nopick")))).toContain("No pick today");
  });

  it("never shows a setup name, a journal free-text field or the retired robot", () => {
    for (const f of ["gap-watch", "gap-flat", "gap-stale"] as const) {
      const body = page(ok(liveDoc(f)));
      expect(body).not.toMatch(/setup|detail|error|Robot B|QQQ|sleeve|paper-s/i);
    }
  });

  it("draws with nothing at all", () => {
    const body = page(null, null);
    expect(body).toContain("Not sent yet");
    expect(body).toContain("No position and no resting order");
  });
});
