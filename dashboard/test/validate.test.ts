import { describe, expect, it } from "vitest";
import { DENY_PATHS, findDenied, validateSnapshot } from "@/lib/validate";
import { fixture, fixtureV3 } from "./helpers";

type Loose = Record<string, unknown>;
const loose = (x: unknown) => x as Loose;

describe("schema validation", () => {
  it("accepts the fixture", () => {
    const r = validateSnapshot(fixture());
    expect(r.ok).toBe(true);
  });

  it("accepts the v3 fixture, and v2 snapshots stay valid (v3 only adds optional keys)", () => {
    expect(validateSnapshot(fixtureV3()).ok).toBe(true);
    expect(fixture().schema_version).toBe(2);
    expect(fixtureV3().schema_version).toBe(3);
  });

  it("rejects a value outside an enum leaf", () => {
    const s = fixtureV3();
    loose(s.sla?.cells?.[0]).status = "great";
    const r = validateSnapshot(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("/sla/cells/0/status");
  });

  it("accepts a snapshot with only the required keys, all null", () => {
    expect(validateSnapshot({ schema: null, schema_version: null, run_id: null, as_of: null }).ok).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(validateSnapshot(null).ok).toBe(false);
    expect(validateSnapshot([]).ok).toBe(false);
    expect(validateSnapshot("x").ok).toBe(false);
  });

  it("rejects a missing required key", () => {
    const s = loose(fixture());
    delete s.run_id;
    const r = validateSnapshot(s);
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    const s = loose(fixture());
    s.surprise = 1;
    const r = validateSnapshot(s);
    expect(r).toEqual({ ok: false, errors: expect.arrayContaining(['/: unknown key "surprise"']) });
  });

  it("rejects an unknown nested key", () => {
    const s = fixture();
    loose(s.ops?.host).hostname = "private-mac.local";
    const r = validateSnapshot(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain('unknown key "hostname"');
      // Errors name paths and keys, never values.
      expect(r.errors.join("\n")).not.toContain("private-mac.local");
    }
  });

  it("rejects wrong types and over-long strings", () => {
    const s = fixture();
    loose(s.kill).on = "yes";
    expect(validateSnapshot(s).ok).toBe(false);
    const t = fixture();
    loose(t.overview).headline = "x".repeat(301);
    expect(validateSnapshot(t).ok).toBe(false);
  });
});

describe("denylist (defense in depth)", () => {
  it("lists the restricted paths", () => {
    expect(DENY_PATHS).toEqual([
      "research.decisions[].title",
      "research.hypotheses[].name",
      "research.hypotheses[].statement",
      "spec.title",
      "spec.open",
    ]);
  });

  it.each([
    ["research.decisions[].title", (s: Loose) => (loose(loose(s.research).decisions) as unknown as Loose[])[0]!, "title"],
    ["research.hypotheses[].name", (s: Loose) => (loose(loose(s.research).hypotheses) as unknown as Loose[])[2]!, "name"],
    ["research.hypotheses[].statement", (s: Loose) => (loose(loose(s.research).hypotheses) as unknown as Loose[])[0]!, "statement"],
    ["spec.title", (s: Loose) => loose(s.spec), "title"],
    ["spec.open", (s: Loose) => loose(s.spec), "open"],
    ["a nested headlines key", (s: Loose) => loose(s.market), "headlines"],
    ["a nested review_url key", (s: Loose) => loose(loose(s.ops).deployed), "review_url"],
    ["a subject key", (s: Loose) => loose(s.deploy), "subject"],
    ["a setup name", (s: Loose) => loose(s.market), "setup"],
    ["a catalyst headline", (s: Loose) => loose(loose(s.ops).routine), "catalyst_headline"],
    ["a catalyst category", (s: Loose) => loose(loose(s.ops).routine), "catalyst_category"],
  ])("rejects %s", (_name, target, key) => {
    const s = loose(fixture());
    target(s)[key] = "restricted text";
    const r = validateSnapshot(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("not allowed to be published"))).toBe(true);
      expect(r.errors.join("\n")).not.toContain("restricted text");
    }
  });

  it("finds denied keys anywhere, even where a schema would allow them", () => {
    const doc = {
      research: { decisions: [{ id: "DEC-1" }, { id: "DEC-2", title: "t" }], hypotheses: [{ statement: "s" }] },
      spec: { open: [] },
      deep: [{ a: { headlines: [] } }],
      ok: { title: "allowed here" },
    };
    expect(findDenied(doc)).toEqual([
      "/research/decisions/1/title",
      "/research/hypotheses/0/statement",
      "/spec/open",
      "/deep/0/a/headlines",
    ]);
  });

  it("allows keys that only share a name with a denied path elsewhere", () => {
    // overview.needs_you[].title and alerts.firing[].title are part of the contract.
    expect(findDenied(fixture())).toEqual([]);
  });
});
