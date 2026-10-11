import { describe, expect, it } from "vitest";
import { fixtureOptionsLive } from "@/lib/fixture-variants";
import type { Options } from "@/lib/options";
import { OTHER_RULE, rulesAreOld, rulesToday } from "@/lib/triggers";
import { validateOptionsLive } from "@/lib/validate";
import optionsJson from "./fixtures/options.v1.json";

const e = optionsJson as unknown as Options;
const NOW = new Date("2026-10-12T16:00:00Z");
const doc = (flags: string[] = []) => fixtureOptionsLive(e as never, NOW, new Set(flags) as never);

describe("the rules' states in today's session", () => {
  it("is a document the site accepts, with and without the block", () => {
    expect(validateOptionsLive(doc())).toMatchObject({ ok: true });
    expect(doc().schema_version).toBe(2);
    expect(validateOptionsLive(doc(["rules-off"]))).toMatchObject({ ok: true });
    expect(doc(["rules-off"]).rules).toBeUndefined();
    const bad = doc();
    (bad.rules!.names[0]!.states[0] as Record<string, unknown>).entry = 100.9;
    expect(validateOptionsLive(bad).ok).toBe(false); // no price travels in this block
    const notProvisional = doc();
    (notProvisional.rules as Record<string, unknown>).provisional = false;
    expect(validateOptionsLive(notProvisional).ok).toBe(false);
  });

  it("lists what has triggered, latest first, by the rule's label and never its id", () => {
    const r = rulesToday(doc(), e, NOW.getTime())!;
    expect(r.session).toBe(e.session);
    expect(r.names).toBe(e.tickers.length);
    expect(r.triggers.map((t) => [t.symbol, t.state, t.bar, t.side, t.r])).toEqual([
      [e.tickers[2]!.symbol, "target", "12:00", "put", 2],
      [e.tickers[0]!.symbol, "open", "11:00", "call", 0.42],
    ]);
    expect(r.triggers.map((t) => t.label)).toEqual([e.rules![3]!.label, e.rules![0]!.label]);
    expect(r.bySymbol[e.tickers[0]!.symbol]![e.rules![0]!.id]).toEqual({ state: "open", bar: "11:00", r: 0.42 });
    expect(r.bySymbol[e.tickers[1]!.symbol]![e.rules![0]!.id]).toEqual({ state: "waiting", bar: null, r: null });
    const odd = doc();
    odd.rules!.names[0]!.states[0]!.rule = "a_rule_the_edition_does_not_carry";
    expect(rulesToday(odd, e, NOW.getTime())!.triggers.find((t) => t.symbol === e.tickers[0]!.symbol)!.label).toBe(OTHER_RULE);
  });

  it("says nothing has triggered when nothing has, and leaves out names the desk does not carry", () => {
    const none = rulesToday(doc(["rules-none"]), e, NOW.getTime())!;
    expect(none.triggers).toEqual([]);
    expect(none.names).toBe(e.tickers.length);
    const extra = doc();
    extra.rules!.names.push({ symbol: "ZZZZ", states: [{ rule: e.rules![0]!.id, state: "open", bar: "10:00" }] });
    expect(rulesToday(extra, e, NOW.getTime())!.triggers.some((t) => t.symbol === "ZZZZ")).toBe(false);
  });

  it("says when the host left names out, ignores a name or rule sent twice, and when the states have gone old", () => {
    const part = doc(["rules-none"]);
    part.rules!.names = part.rules!.names.slice(0, 6);
    const r = rulesToday(part, e, NOW.getTime())!;
    expect([r.names, r.desk]).toEqual([6, e.tickers.length]);
    const twice = doc();
    twice.rules!.names.push({ ...twice.rules!.names[0]! });
    twice.rules!.names[2]!.states.push({ ...twice.rules!.names[2]!.states[3]! });
    expect(rulesToday(twice, e, NOW.getTime())!.triggers).toHaveLength(2);
    const fresh = rulesToday(doc(), e, NOW.getTime())!;
    expect(fresh.ageMin).toBeCloseTo(2, 5);
    expect(rulesAreOld(fresh, true)).toBe(false);
    const late = rulesToday(doc(), e, NOW.getTime() + 45 * 60_000)!;
    expect(rulesAreOld(late, true)).toBe(true);
    expect(rulesAreOld(late, false)).toBe(false); // after the bell an old document is just the day's last
    expect(rulesAreOld({ ...late, complete: true }, true)).toBe(false);
  });

  it("shows nothing for another session's states, with no block, with no document, or once the document is too old", () => {
    expect(rulesToday(null, e, NOW.getTime())).toBeNull();
    expect(rulesToday(doc(["rules-off"]), e, NOW.getTime())).toBeNull();
    const yesterday = doc();
    yesterday.rules!.session = "2026-10-09";
    expect(rulesToday(yesterday, e, NOW.getTime())).toBeNull();
    expect(rulesToday(doc(), e, NOW.getTime() + 37 * 3_600_000)).toBeNull();
    expect(rulesToday(doc(), e, NOW.getTime() + 35 * 3_600_000)).not.toBeNull();
  });
});
