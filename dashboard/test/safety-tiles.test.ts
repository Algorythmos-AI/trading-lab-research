// The Today page's safety switches (src/lib/safety-tiles.ts): one tile per kill file and loss latch the site is
// sent, never "Off" for a state that was not sent, and a late source flagged rather than trusted.
import { describe, expect, it } from "vitest";
import type { OptionsClone } from "@/lib/options-clone.types";
import { safetyView } from "@/lib/safety-tiles";
import type { Snapshot } from "@/lib/types";
import cloneJson from "./fixtures/options-clone.v1.json";
import { cleanSnapshot } from "./helpers";

const NOW = Date.parse("2026-10-12T20:10:00Z");
const clone = (over: Partial<OptionsClone> = {}) => ({ ...(cloneJson as unknown as OptionsClone), ...over });
const snap = (over: Record<string, unknown> = {}) =>
  ({ ...cleanSnapshot(), as_of: "2026-10-12T20:05:00Z", kill: { on: false, since: null, reason: null }, ...over }) as unknown as Snapshot;
const byKey = (v: ReturnType<typeof safetyView>) => Object.fromEntries(v.tiles.map((t) => [t.key, t]));

describe("safetyView", () => {
  it("shows every switch clear when each is sent and off", () => {
    const v = safetyView(snap({ gap_hunter: { kill: false, latched: false } }), clone({ latch: null }), NOW);
    expect(v.tiles.map((t) => [t.key, t.word, t.tone])).toEqual([
      ["kill-s", "Off", "good"],
      ["kill-root", "Off", "good"],
      ["latch-s", "Clear", "good"],
      ["latch-clone", "Clear", "good"],
    ]);
    expect(v.tiles.map((t) => t.label)).toEqual(["Gap Hunter KILL file", "Root KILL file", "Gap Hunter latch", "Options clone latch"]);
    expect(v.onCount).toBe(0);
    expect(v.unknownCount).toBe(0);
    expect(v.overall).toBe("clear");
  });

  it("is never all clear while a switch was not sent, or while a source is late", () => {
    // No Gap Hunter block: its two tiles are unknown, so the panel cannot say clear.
    expect(safetyView(snap(), clone({ latch: null }), NOW).overall).toBe("unknown");
    const late = clone({ latch: null, final: false, as_of: "2026-10-12T19:00:00Z" });
    expect(safetyView(snap({ gap_hunter: { kill: false, latched: false } }), late, NOW).overall).toBe("stale");
  });

  it("names the session of a clone document from an earlier day", () => {
    const v = safetyView(null, clone({ latch: "week", session: "2026-10-09" }), NOW);
    expect(byKey(v)["latch-clone"]).toMatchObject({ on: true, detail: "Week loss limit · From the 2026-10-09 session" });
    expect(v.sources[1]!.label).toBe("Options clone (2026-10-09 session)");
    expect(byKey(safetyView(null, clone({ latch: null }), NOW))["latch-clone"]!.detail).toBeNull();
  });

  it("never says Off or Clear for a state that was not sent", () => {
    const v = safetyView(null, null, NOW);
    expect(v.tiles.every((t) => t.on === null && t.word === "Not sent" && t.tone === "neutral")).toBe(true);
    expect(v.unknownCount).toBe(v.tiles.length);
    expect(v.sources.map((s) => [s.source, s.asOf, s.stale])).toEqual([
      ["snapshot", null, false],
      ["clone", null, false],
    ]);
  });

  it("turns red for a kill file on, a Gap Hunter safety stop and a clone loss latch", () => {
    const v = safetyView(
      snap({ kill: { on: true, since: "2026-10-12T13:00:00Z", reason: null }, gap_hunter: { kill: true, latched: false, safety: { x_latched: ["X3", "bad"] } } }),
      clone({ latch: "day" }),
      NOW,
    );
    const t = byKey(v);
    expect(t["kill-root"]).toMatchObject({ on: true, word: "On", tone: "bad" });
    expect(t["kill-root"]!.detail).toContain("2026-10-12");
    expect(t["kill-s"]).toMatchObject({ on: true, tone: "bad" });
    // A safety stop latches it even when the block's own flag is false; only X codes are named.
    expect(t["latch-s"]).toMatchObject({ on: true, word: "Latched", detail: "Safety stops: X3" });
    expect(t["latch-clone"]).toMatchObject({ on: true, word: "Latched", detail: "Day loss limit" });
    expect(v.onCount).toBe(4);
    expect(v.overall).toBe("on");
  });

  it("flags the clone's document as stale only when it is not the close's and is old", () => {
    const old = "2026-10-12T19:00:00Z"; // 70 minutes before NOW
    expect(safetyView(null, clone({ as_of: old, final: false }), NOW).sources[1]).toMatchObject({ stale: true });
    expect(safetyView(null, clone({ as_of: old, final: true }), NOW).sources[1]).toMatchObject({ stale: false });
    expect(safetyView(null, clone({ as_of: "2026-10-12T20:00:00Z", final: false }), NOW).sources[1]).toMatchObject({ stale: false });
  });

  it("flags a stocks snapshot that is late inside its window", () => {
    const windows = [{ session: "2026-10-12", start: "2026-10-12T13:00:00Z", end: "2026-10-12T21:00:00Z" }];
    const late = safetyView(snap({ as_of: "2026-10-12T19:00:00Z", expected_windows: windows }), null, NOW);
    expect(late.sources[0]).toMatchObject({ source: "snapshot", stale: true });
    const fresh = safetyView(snap({ as_of: "2026-10-12T20:05:00Z", expected_windows: windows }), null, NOW);
    expect(fresh.sources[0]).toMatchObject({ stale: false });
  });
});
