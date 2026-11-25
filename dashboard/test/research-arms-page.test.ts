import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ARMS_FRAME, ArmsStory } from "@/components/research-arms/arms-story";
import type { PaperOptions } from "@/lib/paper-options.types";
import { WINDOW_SESSIONS } from "@/lib/research-arms";
import type { PaperOptionsResult } from "@/lib/snapshot";
import paperV1 from "./fixtures/paper-options.v1.json";
import paperV2 from "./fixtures/paper-options.v2.json";
import { NON_REAL_FRAMES } from "./env-allowlist";
import { assertOnlyEnvs } from "./env-guard";

// The Research arms page (DEC-0041, EXP-0030), rendered from the fixtures in every state the paper options document
// can be in: the story always shows; the figures show only where the document carries them, one arm at a time.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/research/arms",
  useSearchParams: () => new URLSearchParams(),
}));

const now = new Date("2026-11-25T15:00:00Z");
const doc = (base: unknown, mutate?: (d: PaperOptions) => void): PaperOptions => {
  const d = structuredClone(base) as PaperOptions;
  mutate?.(d);
  return d;
};
/**
 * The fixtures' arm trades are dated September and October, before the arms' window. This moves each distinct
 * session onto a window session (in order, wrapping), keeping every time of day, so the figures can be checked.
 */
const intoWindow = (d: PaperOptions) => {
  const days = [...new Set(d.arms!.flatMap((a) => a.trades.map((t) => t.opened_at.slice(0, 10))))].sort();
  const map = new Map(days.map((x, i) => [x, WINDOW_SESSIONS[i % WINDOW_SESSIONS.length]!]));
  for (const a of d.arms!)
    for (const t of a.trades) {
      const to = map.get(t.opened_at.slice(0, 10))!;
      t.opened_at = to + t.opened_at.slice(10);
      t.closed_at = to + t.closed_at.slice(10);
      t.session = to;
    }
};
const ok = (d: PaperOptions): PaperOptionsResult => ({ status: "ok", doc: d, source: "fixture" });
const render = (result: PaperOptionsResult) => renderToStaticMarkup(createElement(ArmsStory, { result, now }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const usd = (v: number) => `${v < 0 ? "−" : "+"}US$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (html: string, re: RegExp) => [...html.matchAll(re)].length;
const round = (v: number) => Math.round(v * 100) / 100;

const STORY = ['id="timeline"', 'id="lineage"', 'id="how"', 'id="pipeline"', 'id="trials"', 'id="calendar"', 'id="shadow"', 'id="verdict-test"', 'id="where-it-went"', 'id="gate"', "data-arms-hero", "data-runway", "data-band-off"];

describe("the story", () => {
  for (const [name, result] of [
    ["v2 in the window", ok(doc(paperV2, intoWindow))],
    ["v2 as the fixture is", ok(doc(paperV2))],
    ["v1, no lab", ok(doc(paperV1))],
    ["no arms", ok(doc(paperV2, (d) => delete d.arms))],
    ["empty arms", ok(doc(paperV2, (d) => (d.arms = [])))],
    ["empty lab", ok(doc(paperV2, (d) => (d.lab = { ...d.lab!, sessions: [], shadow_done: 0, counted: 0, recorded: 0, archived: 0 })))],
    ["no document", { status: "missing" } as const],
    ["unreadable storage", { status: "error" } as const],
  ] as const) {
    it(`renders every block (${name})`, () => {
      const html = render(result);
      for (const b of STORY) expect(html, b).toContain(b);
      expect(count(html, /data-trial="HYP-00\d\d"/g)).toBe(14);
      expect(count(html, /Result sealed until its report/g)).toBe(10);
      expect(count(html, /data-next-table=/g)).toBe(4);
      expect(text(html)).toContain("5 Nov 2027");
      expect(text(html)).toContain("5–17 Nov 2026");
    });
  }

  it("says the storage could not be read, and still tells the story", () => {
    const t = text(render({ status: "error" }));
    expect(t).toContain("Storage could not be read");
    expect(t).toContain("The arms' simulated trades could not be read");
    expect(t).toContain("The lab's tape status could not be read");
    expect(t).not.toContain("not being sent yet");
  });

  it("names no registered trial, no setup and no rule", () => {
    const t = text(render(ok(doc(paperV2, intoWindow))));
    expect(t).not.toMatch(/\bOC-[A-Z]|\bH-[A-Z]{3,}|\bretest\b|\brejection\b|\breclaim|\brunner\b|\btrap\b|\bNTZ\b|\bleader\b|(?<!model )\bgap\b|\bsector\b|volatility|second contract|\bSMH\b/i);
  });

  it("links every record id to the record's own page", () => {
    const html = render(ok(doc(paperV2)));
    for (const id of ["DEC-0041", "EXP-0030", "DEC-0056", "DEC-0059", "DEC-0060", "DEC-0067", "EXP-0052", "HYP-0034", "HYP-0047", "DEC-0080"]) expect(html).toContain(`href="/research/records/${id}"`);
  });

  it("shows no illustrative number: the verdict section draws the method only, and the band is off", () => {
    const html = render(ok(doc(paperV2, intoWindow)));
    const verdict = text(html.slice(html.indexOf('id="verdict-test"'), html.indexOf('id="next"')));
    expect(verdict).toContain("The band on real trades is switched off");
    expect(verdict).toContain("DEC-0080");
    expect(html).not.toContain("data-band=");
    expect(verdict.match(/[−+-]?\d+\.\d%/g)).toBeNull();
  });
});

describe("the shadow arms' figures", () => {
  it("show each arm's own total, equal to a plain sum of its own rows, and nothing pooled across arms", () => {
    const d = doc(paperV2, intoWindow);
    const html = render(ok(d));
    for (const a of d.arms!) {
      const at = html.indexOf(`id="arm-${a.hyp}"`);
      const panel = html.slice(at, html.indexOf("</details>", at));
      expect(text(panel)).toContain(usd(round(a.trades.reduce((s, t) => s + t.pnl_usd, 0))));
    }
    const all = d.arms!.flatMap((a) => a.trades);
    expect(text(html)).not.toContain(usd(round(all.reduce((s, t) => s + t.pnl_usd, 0))));
    const sessions = new Set(all.map((t) => t.session)).size;
    expect(text(html.slice(0, html.indexOf('id="timeline"')))).not.toMatch(new RegExp(`\\b${sessions}\\b(?! (Nov|market))`));
  });

  it("show nothing booked before 5 Nov or after 17 Nov 2026", () => {
    const d = doc(paperV2, (x) => {
      intoWindow(x);
      const first = x.arms![0]!;
      const t0 = first.trades[0]!;
      first.trades.push({ ...t0, vid: "late-1", session: "2026-11-18", opened_at: "2026-11-18T15:30:00Z", closed_at: "2026-11-18T16:00:00Z", pnl_usd: 987.65 });
      first.trades.push({ ...t0, vid: "early-1", session: "2026-11-04", opened_at: "2026-11-04T15:30:00Z", closed_at: "2026-11-04T16:00:00Z", pnl_usd: 876.54 });
    });
    const t = text(render(ok(d)));
    expect(t).not.toContain("987.65");
    expect(t).not.toContain("876.54");
    expect(t).toContain(`Every simulated trade (${d.arms![0]!.trades.length - 2})`);
  });

  it("show the fixture as it is (trades before the window) as no trade in the window, and say so in the calendar", () => {
    const t = text(render(ok(doc(paperV2))));
    expect(t).toContain("No simulated trade in its window");
    expect(t).toMatch(/\d+ trades are dated outside the window and left out/);
  });

  it("say when the arms are not sent, or none was counted", () => {
    expect(text(render(ok(doc(paperV2, (d) => delete d.arms))))).toContain("The arms' simulated trades are not being sent yet");
    expect(text(render(ok(doc(paperV2, (d) => (d.arms = [])))))).toContain("No simulated trade from 5 to 17 Nov 2026");
  });

  it("meter each shadow arm toward 30 trades and 20 sessions, never past 9 sessions", () => {
    const html = render(ok(doc(paperV2, intoWindow)));
    for (const m of html.matchAll(/(\d+) of 20/g)) expect(Number(m[1])).toBeLessThanOrEqual(20);
    const shadowCards = html.split('data-kind="shadow"').slice(1).map((c) => text(c.slice(0, c.indexOf("</li>"))));
    expect(shadowCards).toHaveLength(4);
    for (const c of shadowCards) {
      const s = /Sessions (\d+) of 20/.exec(c);
      expect(s, c).not.toBeNull();
      expect(Number(s![1])).toBeLessThanOrEqual(9);
    }
  });

  it("sit in the one shadow frame the allowlist names, and nowhere else", () => {
    const html = render(ok(doc(paperV2, intoWindow)));
    expect(NON_REAL_FRAMES["research-arms"]).toEqual([{ env: "shadow", label: ARMS_FRAME }]);
    expect(count(html, /data-env-frame=""/g)).toBe(1);
    expect(html).toContain(`: ${ARMS_FRAME}"`);
    assertOnlyEnvs(html, ["shadow"]);
  });
});

describe("the page's wording and layout details", () => {
  const html = render(ok(doc(paperV2, intoWindow))).replace(/<!-- -->/g, "");

  it("puts a space on both sides of the dot between a trial's base and its test", () => {
    const cards = html.split("data-trial=").slice(1).map((c) => c.slice(0, c.indexOf("</li>")));
    expect(cards).toHaveLength(14);
    for (const c of cards) expect(c, c.slice(0, 40)).toMatch(/\S \u00b7 tests the /);
    expect(html).not.toMatch(/[^\s>]\u00b7 tests/);
  });

  it("says a rate or an average is shown from 8 trades, not that it was taken from 8", () => {
    expect(text(html)).not.toMatch(/(^|[^n] )From 8 trades/);
    expect(text(html)).toContain("Shown from 8 trades");
  });

  it("says the stage-2 tables are locked until 20 counted sessions, not that they come next", () => {
    expect(text(html)).not.toContain("Coming next");
    expect(count(html, /Locked until 20 counted sessions/g)).toBe(4);
  });

  it("keeps each arm's id on one line in the session grid", () => {
    expect(count(html, /<th scope="row" class="[^"]*whitespace-nowrap/g)).toBe(4);
  });
});

describe("the calendar", () => {
  it("has a row per shadow arm, a cell per window session and the 11 sessions never booked", () => {
    const d = doc(paperV2, intoWindow);
    const html = render(ok(d));
    expect(count(html, /data-heat="HYP-00\d\d"/g)).toBe(d.arms!.length);
    expect(text(html)).toContain("11 more needed");
  });

  it("says when the arms are not sent", () => {
    expect(text(render(ok(doc(paperV2, (d) => delete d.arms))))).toContain("The arms' simulated trades are not being sent yet");
  });
});

describe("the lab card and gate", () => {
  it("shows the shadow period and the road to the first tables from the lab block", () => {
    const d = doc(paperV2);
    const html = render(ok(d));
    const t = text(html);
    expect(t).toContain(`${d.lab!.shadow_done} of ${d.lab!.shadow_needed}`);
    expect(t).toContain(`${d.lab!.counted} of 20`);
    expect(count(html, /data-gate="/g)).toBeGreaterThanOrEqual(25);
  });

  it("says the lab's status is not sent without a lab block, and draws no gate cell", () => {
    const html = render(ok(doc(paperV1)));
    expect(text(html)).toContain("The lab's tape status is not being sent yet");
    expect(text(html)).toContain("The lab's sessions are not being sent yet");
    expect(count(html, /data-gate="/g)).toBe(0);
  });

  it("draws every pending cell for an empty lab, marking counted session 10 (plan) and 20 (EXP-0052)", () => {
    const html = render(ok(doc(paperV2, (d) => (d.lab = { ...d.lab!, sessions: [], shadow_done: 0, counted: 0, recorded: 0, archived: 0 }))));
    expect(count(html, /data-gate="pending"/g)).toBe(25);
    expect(count(html, /data-gate-mark="plan"/g)).toBe(1);
    expect(count(html, /data-gate-mark="read"/g)).toBe(1);
    expect(text(html)).toContain("owner plan, not a record");
    expect(text(html)).not.toMatch(/consecutive|restart/i);
  });

  it("links to the Paper page's arms table and lab, Research and the glossary", () => {
    const html = render(ok(doc(paperV2)));
    for (const href of ["/paper#arms-table", "/paper#options-lab", "/research", "/glossary"]) expect(html).toContain(`href="${href}"`);
  });
});

describe("the live pipeline", () => {
  it("marks the arms' booking off and reports what it has seen; unknown without a document", () => {
    expect(render(ok(doc(paperV2)))).toMatch(/data-wires="(live|stale) (live|stale) (live|stale|unknown)"/);
    expect(render({ status: "missing" })).toContain('data-wires="unknown unknown unknown"');
    expect(text(render({ status: "missing" }))).toContain("Switched off: from the 19 Nov session");
  });
});
