// The Radar → Options shadow on the Radar pipeline card (DEC-0070): its states through the morning, its counts, and
// that it never moves the pipeline's headline, stages or on-time record.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pipelineView, RadarPipelineView } from "@/components/client/radar-pipeline";
import type { SelectSession } from "@/lib/paper-options.types";
import { fixturePipeline } from "@/lib/radar-pipeline-fixture";
import { CLEAN_NEEDED, NOT_CLEAN_WORDS, progressView, publishedWords, RADAR_STATUS_WORDS, type SelectBlock, shadowView, topRejects } from "@/lib/select-shadow";
import { validatePaperOptions } from "@/lib/validate";
import paperV2 from "./fixtures/paper-options.v2.json";

const t = (iso: string) => Date.parse(iso);
const FROZEN = t("2026-10-12T15:01:00Z"); // 11:01 New York on the fixture's session
const S = "2026-10-12";
const block = (structuredClone(paperV2) as unknown as { select: SelectBlock }).select;
const run = (over: Partial<SelectSession> = {}): SelectSession => ({ ...block.sessions[1]!, ...over });

describe("the shadow's state", () => {
  it("is the run when the host sent one for the session", () => {
    const v = shadowView(block, S, FROZEN);
    expect(v.state).toBe("ran");
    expect(v.run?.universe.candidates_gated).toBe(14);
  });

  it("is not due before 06:45 New York, running until 08:00, then overdue", () => {
    const none: SelectBlock = { ...block, sessions: [] };
    expect(shadowView(none, S, t("2026-10-12T10:30:00Z")).state).toBe("not_due"); // 06:30 EDT
    expect(shadowView(none, S, t("2026-10-12T11:30:00Z")).state).toBe("running"); // 07:30
    expect(shadowView(none, S, t("2026-10-12T12:05:00Z")).state).toBe("overdue"); // 08:05
    expect(shadowView(none, "2026-11-23", t("2026-11-23T11:40:00Z")).state).toBe("not_due"); // 06:40 EST
    expect(shadowView(none, "2026-11-23", t("2026-11-23T11:50:00Z")).state).toBe("running"); // 06:50 EST
  });

  it("says the host sent nothing, or that its switch is off, instead of a miss", () => {
    expect(shadowView(null, S, FROZEN).state).toBe("no_record");
    expect(shadowView({ ...block, off: true, sessions: [] }, S, FROZEN).state).toBe("off");
  });

  it("lists the largest reject codes first", () => {
    expect(topRejects({ gate_unset: 3, earnings_unknown: 5, chain_thin: 5, bars_short: 1 }, 2)).toEqual([
      { code: "chain_thin", count: 5 },
      { code: "earnings_unknown", count: 5 },
    ]);
    expect(topRejects(undefined)).toEqual([]);
  });
});

describe("the card", () => {
  const html = (shadow: SelectBlock | null | undefined) =>
    renderToString(createElement(RadarPipelineView, { file: fixturePipeline(FROZEN), nowMs: FROZEN, shadow }));

  it("draws the three shadow stages in counts, and says it is not the published focus", () => {
    const out = html(block);
    expect(out).toContain('data-shadow-state="ran"');
    expect(out.match(/data-shadow-stage=/g)).toHaveLength(3);
    expect(out).toContain("not the published focus");
    expect(out).toContain("Gate thresholds not set");
    expect(out).toContain("gate unset 14");
  });

  it("is not drawn without a shadow prop, and draws a plain no-record line when the host sent none", () => {
    expect(html(undefined)).not.toContain("data-shadow-card");
    expect(html(null)).toContain('data-shadow-state="no_record"');
  });

  it("never moves the headline, the stages or the on-time record", () => {
    const strip = (s: string) => s.replace(/<section aria-label="Shadow selection"[\s\S]*?<\/section>/, "");
    const base = html(undefined);
    for (const shadow of [null, block, { ...block, sessions: [run({ late: true, radar_bars_ok: false, radar_status: "radar_missing" })] }]) {
      expect(strip(html(shadow))).toBe(base);
    }
    const v = pipelineView(fixturePipeline(FROZEN), FROZEN);
    expect(v.headline.kind).toBe("on_time");
  });

  it("carries no symbol: the fixture's block validates, and a symbol or a pick list does not", () => {
    expect(validatePaperOptions(structuredClone(paperV2)).ok).toBe(true);
    const out = html(block);
    for (const sym of ["SPY", "QQQ", "AAPL", "NVDA", "TSLA"]) expect(out).not.toContain(`>${sym}<`);
  });
});

describe("the Radar status words", () => {
  it("call a stale edition not fresh, whatever made it stale (date, store time or another check)", () => {
    expect(RADAR_STATUS_WORDS.radar_stale).toBe("Radar not fresh: ran on the desk's 12");
    expect(Object.values(RADAR_STATUS_WORDS).join(" ")).not.toContain("not this session's");
  });
});

describe("the shadow's progress (version 5)", () => {
  const html = (shadow: SelectBlock | null) =>
    renderToString(createElement(RadarPipelineView, { file: fixturePipeline(FROZEN), nowMs: FROZEN, shadow }));
  const bad = (f: (d: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const d = structuredClone(paperV2) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    f(d);
    return validatePaperOptions(d).ok;
  };

  it("counts the host's clean sessions and marks each recent run clean, not clean or not checked", () => {
    const p = progressView(block)!;
    expect(p).toMatchObject({ clean: 1, needed: 5, tracked: true });
    expect(p.marks.map((m) => m.mark)).toEqual(["not_clean", "clean"]);
    expect(p.marks[0]!.reasons).toEqual(["radar_not_ok", "no_radar_candidates"]);
    expect(progressView(null)).toBeNull();
  });

  it("reads a version 4 block (no progress, no checks) as not tracked, every run not checked", () => {
    const v4: SelectBlock = { mode: "shadow", off: false, sessions: block.sessions.map(({ check: _c, ...s }) => s) };
    const p = progressView(v4)!;
    expect(p).toMatchObject({ clean: 0, needed: CLEAN_NEEDED, tracked: false });
    expect(p.marks.every((m) => m.mark === "no_check")).toBe(true);
    expect(html(v4)).toContain("the host does not check its runs yet");
  });

  it("draws the progress, the session's check and the overlap count, never a name", () => {
    const out = html(block);
    expect(out).toContain("data-shadow-progress");
    expect(out).toMatch(/1<!-- --> of <!-- -->5<!-- --> clean/);
    expect(out).toContain('data-shadow-check="clean"');
    expect(out).toContain("Clean session: it counts");
    expect(out).toContain("3 of the published 4 also picked by the shadow");
    expect(out.match(/data-check-mark=/g)).toHaveLength(2);
    for (const sym of ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "PLTR"]) expect(out).not.toContain(sym);
  });

  it("names every reason a session is not clean in words", () => {
    const sessions = [{ ...block.sessions[1]!, check: { ...block.sessions[1]!.check!, clean: false, reasons: ["late", "replay_differs"] as ("late" | "replay_differs")[], replay: "differs" as const } }];
    const out = html({ ...block, sessions });
    expect(out).toContain('data-shadow-check="not_clean"');
    expect(out).toContain("Not clean: late, the replay differs");
    expect(out).toContain("Replay differs");
    for (const code of ["radar_not_ok", "late", "radar_bars_failed", "no_radar_candidates", "facts_missing", "replay_differs", "replay_error", "check_invalid"])
      expect(NOT_CLEAN_WORDS[code]).toBeTruthy();
  });

  it("says why the overlap is unknown instead of a number", () => {
    const c = block.sessions[1]!.check!;
    expect(publishedWords({ ...c, published: { status: "other_session", overlap: null, of: null } })).toContain("another session");
    expect(publishedWords({ ...c, published: { status: "not_read", overlap: null, of: null } })).toContain("not read");
    expect(publishedWords({ ...c, published: { status: "unreadable", overlap: null, of: null } })).toContain("unreadable");
    expect(publishedWords(null)).toBeNull();
  });

  it("validates only codes and counts: a name, a free-text reason or an unknown status is refused", () => {
    expect(bad(() => {})).toBe(true);
    expect(bad((d) => (d.select.sessions[1].check.published.names = ["AAA"]))).toBe(false);
    expect(bad((d) => (d.select.sessions[1].check.picks = ["AAA"]))).toBe(false);
    expect(bad((d) => (d.select.sessions[1].check.reasons = ["because it broke"]))).toBe(false);
    expect(bad((d) => (d.select.sessions[1].check.replay = "maybe"))).toBe(false);
    expect(bad((d) => (d.select.sessions[1].check.published.status = "AAA"))).toBe(false);
    expect(bad((d) => (d.select.progress.clean = -1))).toBe(false);
    expect(bad((d) => (d.select.progress.extra = 1))).toBe(false);
    expect(bad((d) => { d.schema_version = 4; delete d.select.progress; for (const s of d.select.sessions) delete s.check; })).toBe(true);
  });
});
