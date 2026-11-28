// The Today page's safety switches (src/lib/safety-tiles.ts): one tile per kill file and loss latch the site is
// sent, never "Off" for a state that was not sent, Gap Hunter read from the same copy as its own page, and a late
// source flagged rather than trusted.
import { describe, expect, it } from "vitest";
import type { GapHunterLive } from "@/lib/gap-hunter-live.types";
import type { OptionsClone } from "@/lib/options-clone.types";
import { nyDate, safetyView } from "@/lib/safety-tiles";
import type { GapHunterLiveResult } from "@/lib/snapshot";
import type { Snapshot } from "@/lib/types";
import cloneJson from "./fixtures/options-clone.v1.json";
import { cleanSnapshot } from "./helpers";

const NOW = Date.parse("2026-10-12T15:01:00Z"); // Monday 11:01 New York, inside Gap Hunter's window
const clone = (over: Partial<OptionsClone> = {}) => ({ ...(cloneJson as unknown as OptionsClone), ...over });
const snap = (over: Record<string, unknown> = {}) =>
  ({ ...cleanSnapshot(), as_of: "2026-10-12T15:00:00Z", kill: { on: false, since: null, reason: null }, ...over }) as unknown as Snapshot;
const gap = (over: Record<string, unknown> = {}) => ({ as_of: "2026-10-12T15:00:00Z", kill: false, latched: false, safety: { x_latched: [] }, ...over });
const live = (block: Record<string, unknown>): GapHunterLiveResult => ({
  status: "ok",
  source: "fixture",
  doc: { schema: "stocksdelta/gap-hunter-live", schema_version: 1, run_id: "t", as_of: String(block.as_of), paper: true, gap_hunter: block } as unknown as GapHunterLive,
});
const byKey = (v: ReturnType<typeof safetyView>) => Object.fromEntries(v.tiles.map((t) => [t.key, t]));

describe("safetyView", () => {
  it("shows every switch clear when each is sent and off", () => {
    const v = safetyView(snap({ gap_hunter: gap() }), clone({ latch: null }), NOW);
    expect(v.tiles.map((t) => [t.key, t.label, t.word, t.tone])).toEqual([
      ["kill-s", "Gap Hunter KILL file", "Off", "good"],
      ["kill-root", "Root KILL file", "Off", "good"],
      ["latch-s", "Gap Hunter latch", "Clear", "good"],
      ["latch-clone", "Options clone latch", "Clear", "good"],
    ]);
    expect(v).toMatchObject({ onCount: 0, unknownCount: 0, overall: "clear" });
    expect(v.sources.map((x) => [x.source, x.label, x.stale])).toEqual([
      ["snapshot", "Stocks snapshot", false],
      ["gap", "Gap Hunter (snapshot)", false],
      ["clone", "Options clone", false],
    ]);
  });

  it("never says Off or Clear for a state that was not sent, and never all clear then", () => {
    const v = safetyView(null, null, NOW);
    expect(v.tiles.every((t) => t.on === null && t.word === "Not sent" && t.tone === "neutral")).toBe(true);
    expect(v).toMatchObject({ unknownCount: 4, overall: "unknown" });
    // No Gap Hunter block: its two tiles are unknown, so the panel cannot say clear.
    expect(safetyView(snap(), clone({ latch: null }), NOW).overall).toBe("unknown");
  });

  it("turns red for a kill file on, a Gap Hunter safety stop and a clone loss latch", () => {
    const v = safetyView(
      snap({ kill: { on: true, since: "2026-10-12T03:00:00Z", reason: null }, gap_hunter: gap({ kill: true, safety: { x_latched: ["X3", "bad"] } }) }),
      clone({ latch: "day" }),
      NOW,
    );
    const t = byKey(v);
    expect(t["kill-root"]).toMatchObject({ on: true, word: "On", tone: "bad" });
    // The day is New York's: 03:00 UTC on the 12th is still the 11th there.
    expect(t["kill-root"]!.detail).toBe("On since 2026-10-11; exits still managed.");
    expect(t["kill-s"]).toMatchObject({ on: true, tone: "bad" });
    // A safety stop latches it even when the block's own flag is false; only X codes are named.
    expect(t["latch-s"]).toMatchObject({ on: true, word: "Latched", detail: "Safety stops: X3" });
    expect(t["latch-clone"]).toMatchObject({ on: true, word: "Latched", detail: "Day loss limit" });
    expect(v).toMatchObject({ onCount: 4, overall: "on" });
  });

  it("reads Gap Hunter from its newer live document, as the Gap Hunter page does", () => {
    const s = snap({ gap_hunter: gap({ as_of: "2026-10-12T14:50:00Z", latched: false }) });
    const v = safetyView(s, clone(), NOW, live(gap({ as_of: "2026-10-12T15:00:30Z", latched: true })));
    expect(byKey(v)["latch-s"]).toMatchObject({ on: true, word: "Latched" });
    expect(v.sources[1]).toMatchObject({ source: "gap", label: "Gap Hunter (live document)", asOf: "2026-10-12T15:00:30Z", stale: false });
    // An older live document loses to the snapshot's block.
    const w = safetyView(s, clone(), NOW, live(gap({ as_of: "2026-10-12T14:00:00Z", latched: true })));
    expect(byKey(w)["latch-s"]).toMatchObject({ on: false });
  });

  it("flags a Gap Hunter copy that is late in its window, and a late stocks snapshot", () => {
    const late = safetyView(snap({ gap_hunter: gap() }), clone(), NOW, live(gap({ as_of: "2026-10-12T14:40:00Z" })));
    // The snapshot block (15:00) is newer than this live copy, so the snapshot's rhythm applies: fresh.
    expect(late.sources[1]!.stale).toBe(false);
    const old = safetyView(snap({ gap_hunter: gap({ as_of: "2026-10-12T14:20:00Z" }) }), clone(), NOW);
    expect(old.sources[1]).toMatchObject({ stale: true });
    expect(old.overall).toBe("stale");

    const windows = [{ session: "2026-10-12", start: "2026-10-12T13:00:00Z", end: "2026-10-12T21:00:00Z" }];
    const s = safetyView(snap({ as_of: "2026-10-12T13:30:00Z", expected_windows: windows }), null, NOW);
    expect(s.sources[0]).toMatchObject({ source: "snapshot", stale: true });
  });

  it("shows the clone document's age but never calls it stale: it is sent on every event, a latch included", () => {
    const v = safetyView(null, clone({ as_of: "2026-10-12T13:00:00Z", final: false }), NOW);
    expect(v.sources[2]).toMatchObject({ stale: false, ageMin: 121 });
  });

  it("names the session of a clone document from an earlier day", () => {
    const v = safetyView(null, clone({ latch: "week", session: "2026-10-09" }), NOW);
    expect(byKey(v)["latch-clone"]).toMatchObject({ on: true, detail: "Week loss limit · From the 2026-10-09 session" });
    expect(v.sources[2]!.label).toBe("Options clone (2026-10-09 session)");
    expect(byKey(safetyView(null, clone({ latch: null }), NOW))["latch-clone"]!.detail).toBeNull();
  });

  it("dates by New York", () => {
    expect(nyDate(Date.parse("2026-10-13T01:00:00Z"))).toBe("2026-10-12");
  });
});
