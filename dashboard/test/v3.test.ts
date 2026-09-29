import { describe, expect, it } from "vitest";
import {
  auditTone,
  hasV3,
  limitLabel,
  limitTone,
  sectionState,
  profitFactorText,
  SLA_GLYPH,
  SLA_LABEL,
  SLA_TONE,
  slaStatus,
  suppressedReason,
} from "@/lib/v3";
import { fixture, fixtureV3 } from "./helpers";

describe("v3 helpers", () => {
  it("tells a v3 snapshot from a v2 one", () => {
    expect(hasV3(fixtureV3())).toBe(true);
    expect(hasV3(fixture())).toBe(false);
  });

  it("maps every limit and SLA state to a tone, a label and a glyph", () => {
    expect(limitTone("at_limit")).toBe("bad");
    expect(limitTone(null)).toBe("neutral");
    for (const k of Object.keys(SLA_TONE)) {
      expect(SLA_LABEL[k as keyof typeof SLA_LABEL]).toBeTruthy();
      expect(SLA_GLYPH[k as keyof typeof SLA_GLYPH]).toBeDefined();
    }
    expect(slaStatus("missed")).toBe("missed");
    expect(slaStatus("bogus")).toBe("n/a");
    expect(slaStatus(null)).toBe("n/a");
  });

  it("explains suppressed statistics instead of showing zeros", () => {
    expect(suppressedReason({ n: 0 }, 20)).toBe("No closed trades yet.");
    expect(suppressedReason({ n: 7, sample_ok: false }, 20)).toContain("from 20 trades (now 7)");
    expect(suppressedReason({ n: 25, sample_ok: true }, 20)).toBe("");
    expect(profitFactorText({ n: 25, sample_ok: true, pf_no_losses: true })).toBe("No losing trades yet");
    expect(profitFactorText({ n: 25, sample_ok: true, profit_factor: 1.456 })).toBe("1.46");
    expect(profitFactorText({ n: 5, sample_ok: false, profit_factor: 3 })).toBeNull();
  });

  it("treats a used-up daily entry allowance as normal, not a breach", () => {
    expect(limitTone("at_limit", "entries_per_day")).toBe("info");
    expect(limitLabel("at_limit", "entries_per_day")).toBe("Used for today");
    expect(limitLabel("ok", "entries_per_day")).toBe("Available");
    expect(limitTone("at_limit", "day_loss")).toBe("bad");
    expect(limitLabel("at_limit", "day_loss")).toBe("At limit");
  });

  it("tells a section a v3 host failed to build from one a v2 host never sends", () => {
    const v3 = fixtureV3();
    expect(sectionState(v3, v3.perf)).toBe("ok");
    expect(sectionState(v3, null)).toBe("missing");
    expect(sectionState(fixture(), null)).toBe("v2");
  });

  it("colours audit events by what they mean", () => {
    expect(auditTone("job_failed")).toBe("bad");
    expect(auditTone("kill_on")).toBe("warn");
    expect(auditTone("alert_resolved")).toBe("good");
    expect(auditTone("deploy")).toBe("info");
  });

  it("the v3 fixture carries every section the pages read", () => {
    const s = fixtureV3();
    expect(s.risk?.limits?.length).toBeGreaterThan(5);
    expect(s.perf?.curve?.length).toBeGreaterThan(0);
    expect(s.sla?.cells?.length).toBe(5 * 14);
    expect(s.digest?.items?.length).toBeGreaterThan(0);
    expect(s.audit?.events?.length).toBeGreaterThan(0);
    expect(s.alerts?.history?.length).toBeGreaterThan(0);
  });
});
