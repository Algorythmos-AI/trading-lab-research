import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { notes, staleSpan, staleSplit, verdict, WHY } from "@/components/paper/lab-tape";
import { PAPER_FRAMES, PaperBody } from "@/components/paper/paper-page";
import { fixturePaperOptions } from "@/lib/fixture-variants";
import type { OptionsClone } from "@/lib/options-clone.types";
import type { PaperOptions } from "@/lib/paper-options.types";
import type { OptionsCloneResult, PaperOptionsResult } from "@/lib/snapshot";
import cloneJson from "./fixtures/options-clone.v1.json";
import paperJson from "./fixtures/paper-options.v1.json";
import paperV2 from "./fixtures/paper-options.v2.json";
import { NON_REAL_FRAMES } from "./env-allowlist";
import { assertOnlyEnvs } from "./env-guard";

// The Paper options page under its heading (DEC-0057), rendered from the fixture: two books that are never added
// together (the fixture still carries the closed hand-traded account's block, which the page must ignore), each total equal to a plain sum of its own rows, and every state the documents can be in.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/paper",
  useSearchParams: () => new URLSearchParams(),
}));

const now = new Date("2026-10-12T20:30:00Z");
const paper = (mutate?: (d: PaperOptions) => void): PaperOptions => {
  const d = structuredClone(paperJson) as unknown as PaperOptions;
  mutate?.(d);
  return d;
};
const cloneDoc = cloneJson as unknown as OptionsClone;
const render = (
  q: Record<string, string> = {},
  opts: { result?: PaperOptionsResult; clone?: OptionsCloneResult } = {},
) =>
  renderToStaticMarkup(
    createElement(PaperBody, {
      result: opts.result ?? { status: "ok", doc: paper(), source: "fixture" },
      clone: opts.clone ?? { status: "ok", doc: cloneDoc, source: "fixture" },
      q,
      now,
    }),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const usd = (v: number) => `${v < 0 ? "−" : "+"}US$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (rows: readonly { pnl_usd: number | null }[]) => Math.round(rows.reduce((s, r) => s + (r.pnl_usd ?? 0), 0) * 100) / 100;
const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
/** The glance card of a frame: from its opening tag to the next frame's. */
const frame = (html: string, label: string) => {
  const at = html.indexOf(`: ${label}"`);
  expect(at, label).toBeGreaterThan(-1);
  // The label and the frame marker are attributes of one tag: look for the next frame after this tag closes.
  const next = html.indexOf("data-env-frame", html.indexOf(">", at));
  return html.slice(at, next < 0 ? undefined : next);
};

describe("the two books", () => {
  const html = render();
  const d = paper();

  it("each show their own total, equal to a plain sum of their own rows", () => {
    const clone = sum(d.clone.trades.filter((t) => t.counts));
    expect(text(frame(html, PAPER_FRAMES.cloneGlance))).toContain(usd(clone));
    for (const a of d.arms!) expect(text(frame(html, PAPER_FRAMES.armsGlance))).toContain(usd(sum(a.trades)));
    // The section's headline tile says the same as the card.
    expect(text(frame(html, PAPER_FRAMES.clone))).toContain(`Net result ${usd(clone)}`);
  });

  it("are never added together", () => {
    const clone = sum(d.clone.trades.filter((t) => t.counts));
    const arms = d.arms!.map((a) => sum(a.trades));
    const all = text(html);
    const blended = [clone + arms.reduce((s, v) => s + v, 0), arms.reduce((s, v) => s + v, 0)];
    for (const v of blended) expect(all).not.toContain(usd(Math.round(v * 100) / 100).slice(1));
    expect(all).toContain("Two separate books. They are never added together");
  });

  it("shows nothing of the closed hand-traded account, though the document still carries its block", () => {
    expect(d.manual!.trades.length).toBeGreaterThan(0);
    const all = text(html);
    expect(all).not.toMatch(/My paper trades|hand-placed|by hand|Manual option|Open now/i);
    expect(all).not.toContain(usd(sum(d.manual!.trades)));
    expect(html).not.toContain("my-paper-trades");
    // The same page from a document without the block, which is what the host sends once it stops reading that account.
    const without = render({}, { result: { status: "ok", doc: paper((x) => delete (x as { manual?: unknown }).manual), source: "fixture" } });
    expect(text(without)).toBe(all);
  });

  it("sit in exactly the frames the owner's allowlist names, with no real-money figure on the page", () => {
    assertOnlyEnvs(html, ["paper", "shadow"]);
    const labels = [...html.matchAll(/data-env-frame="" data-env="(paper|shadow)"/g)].length;
    expect(labels).toBe(NON_REAL_FRAMES.paper.length);
    expect(html).not.toMatch(/data-env="real"/);
    expect(html).not.toMatch(/REAL · WEBULL/);
  });

  it("draws every element id once, and the jump bar links only to ids it draws", () => {
    const all = ids(html);
    expect(all.filter((v, i) => all.indexOf(v) !== i)).toEqual([]);
    const bar = html.match(/<nav aria-label="On this page"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const links = [...bar.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(links).toEqual(["clone-bot", "options-lab", "research-arms"]);
    expect(links.filter((h) => !all.includes(h))).toEqual([]);
  });

  it("says what the clone's results are after, lists the trade it could not settle, and names no setup", () => {
    const body = text(html);
    expect(body).toContain("After the clone's modelled fee of US$0.03 a contract each way");
    expect(body).toMatch(/1 trade the clone could not settle is in no figure here: \d{4}-\d{2}-\d{2}-O-\d+/);
    expect(body).not.toMatch(/\b(retest|rejection|reclaim|trap)\b/i);
  });
});

describe("the filters", () => {
  it("cut both books by ticker, kind and period, and say so when nothing is left", () => {
    const d = paper();
    const spy = render({ s: "SPY" });
    const want = sum(d.clone.trades.filter((t) => t.counts && t.contract.startsWith("SPY")));
    expect(text(frame(spy, PAPER_FRAMES.cloneGlance))).toContain(usd(want));
    expect(spy).toContain('href="/paper?s=SPY&amp;k=call"');
    const calls = render({ k: "call" });
    expect(text(frame(calls, PAPER_FRAMES.cloneGlance))).toContain(usd(sum(d.clone.trades.filter((t) => t.counts && t.side === "call"))));
    const none = text(render({ s: "ZZZZ" }));
    expect(none).toContain("No clone trades in this view");
    expect(none).toContain("No closed clone trades in this view.");
  });
});

describe("the research arms ended (DEC-0059)", () => {
  it("says counting ended on 17 Nov 2026 with no verdict, at a glance and in the arms section", () => {
    const body = text(render({}));
    expect(body).toContain("Counting ended 17 Nov 2026, no verdict.");
    expect(body).toContain("Counting ended then with too few sessions; each trial closes on 5 Nov 2027 with no verdict.");
  });

  it("says the same when the arms block is sent with no trade in it", () => {
    const body = text(render({}, { result: { status: "ok", doc: paper((d) => { d.arms = []; }), source: "fixture" } }));
    expect(body).toContain("No research arm trade was counted before 17 Nov 2026");
    expect(body).toContain("The arms ran beside the clone until 17 Nov 2026");
  });
});

describe("what the page does without its documents", () => {
  it("still draws today's clone session before any history is sent", () => {
    const body = text(render({}, { result: { status: "missing" } }));
    expect(body).toContain("No paper trade history has been sent yet");
    expect(body).toContain("Options clone (paper)");
    expect(body).toContain("The arms' simulated trades are not being sent yet");
  });

  it("says storage could not be read, and that the clone has sent nothing", () => {
    const body = text(render({}, { result: { status: "error" }, clone: { status: "missing" } }));
    expect(body).toContain("Storage could not be read");
    expect(body).toContain("No session from the clone yet");
  });

  it("draws the clone alone when the host sends no arms", () => {
    const html = render({}, { result: { status: "ok", doc: fixturePaperOptions(paper(), new Set(["partial"])), source: "fixture" } });
    const body = text(html);
    expect(body).toContain("Every clone trade");
    expect(body).toContain("The arms' simulated trades are not being sent yet");
    assertOnlyEnvs(html, ["paper", "shadow"]);
  });

  it("leaves out a row it cannot read and says how many, with every other figure standing", () => {
    const d = paper();
    const html = render({}, { result: { status: "ok", doc: fixturePaperOptions(paper(), new Set(["poison"])), source: "fixture" } });
    expect(html).toContain('data-paper-skipped="1"');
    expect(text(html)).toContain("1 row could not be read and is left out.");
    const rest = sum(d.clone.trades.slice(1).filter((t) => t.counts));
    expect(text(frame(html, PAPER_FRAMES.cloneGlance))).toContain(usd(rest));
  });

  it("warns when the history is more than a day old, when rows were left off, and when its total is out of step with the clone's own", () => {
    const stale = text(renderToStaticMarkup(createElement(PaperBody, { result: { status: "ok", doc: paper(), source: "fixture" }, clone: { status: "missing" }, q: {}, now: new Date("2026-10-15T14:00:00Z") })));
    expect(stale).toContain("This history was last sent on");
    expect(text(render())).not.toContain("This history was last sent on");
    expect(text(render({}, { result: { status: "ok", doc: paper((d) => (d.clone.truncated = 12)), source: "fixture" } }))).toContain("12 older trades are left out");
    const d = paper();
    const counted = d.clone.trades.filter((t) => t.counts);
    const cloneSays = (total: number): OptionsCloneResult => ({ status: "ok", source: "fixture", doc: { ...cloneDoc, setups: cloneDoc.setups.map((s) => (s.hyp === "all" ? { ...s, trades: counted.length, total_usd: total } : s)) } });
    expect(text(render({}, { clone: cloneSays(sum(counted) + 100) }))).toContain("One of the two is out of step");
    expect(text(render({}, { clone: cloneSays(sum(counted)) }))).not.toContain("out of step");
    // A different count is a trade one document has and the other does not yet: no warning.
    expect(text(render())).not.toContain("out of step");
  });
});

describe("the options lab's tape (DEC-0060, DEC-0067)", () => {
  const withLab = paperV2 as unknown as PaperOptions;
  const lab = (doc: PaperOptions = withLab) =>
    renderToStaticMarkup(createElement(PaperBody, { result: { status: "ok", doc, source: "fixture" }, clone: { status: "ok", doc: cloneDoc, source: "fixture" }, q: {}, now }));

  it("shows one line a session, newest first, each coloured by whether it counts and saying why not", () => {
    const html = lab();
    const days = [...html.matchAll(/data-lab-session="([\d-]+)" data-tone="(\w+)"/g)].map((m) => [m[1], m[2]]);
    expect(days.map((d) => d[0])).toEqual([...withLab.lab!.sessions.map((s) => s.date)].reverse());
    const tone = Object.fromEntries(days);
    expect(tone["2026-10-01"]).toBe("bad");                    // the v1 recorder: never counts
    expect(tone["2026-10-05"]).toBe("bad");                    // stale names: does not count
    expect(tone["2026-10-06"]).toBe("warn");                   // a shadow session
    expect(tone["2026-10-09"]).toBe("warn");                   // counts, partial
    expect(tone["2026-10-12"]).toBe("bad");
    expect(html).toContain(WHY.v1);
    expect(html).toContain(WHY.fresh_coverage);
    expect(html).toContain(WHY.stale_run);
    expect(html).toContain("stopped by the off switch");
  });

  it("sums up the shadow period, the counted sessions and the archive", () => {
    const html = lab();
    expect(html).toContain("Shadow period done");
    expect(html).toContain("1 counted session");
    expect(html).toContain("4 of 8 not archived");
  });

  it("shows each session's rate-limit low and how long after the close it was archived", () => {
    const html = lab();
    const row = (day: string) => html.split(`data-lab-session="${day}"`)[1]!.split("</tr>")[0]!;
    expect(html).toContain("1 upload past close + 110 min");
    expect(row("2026-10-05")).toContain("uploaded 4.0 h after the close (due within 110 min)");
    expect(row("2026-10-05")).toMatch(/text-warn[^>]*data-lab-upload[^>]*>4\.0 h/);
    expect(row("2026-10-02")).toMatch(/data-lab-upload[^>]*>1\.6 h/);
    expect(row("2026-10-06")).toMatch(/text-warn[^>]*data-lab-headroom[^>]*>18%/);
    expect(row("2026-10-06")).toContain("2 requests refused by Alpaca&#x27;s rate limit");
    expect(row("2026-10-06")).toContain("7 sweep batches skipped by the lab&#x27;s own request budget");
    expect(row("2026-10-06")).toContain("rate limit under 30% left 4 times");
    expect(row("2026-10-01")).toMatch(/data-lab-headroom[^>]*>—/);          // saved only by later recorders
    expect(row("2026-10-07")).toMatch(/data-lab-upload[^>]*>—/);            // not archived yet
  });

  it("says where the stale ticks fell when the recorder splits them, and short runs in seconds", () => {
    const html = lab();
    const row = (day: string) => html.split(`data-lab-session="${day}"`)[1]!.split("</tr>")[0]!;
    expect(row("2026-10-05")).toContain("2 names stale for 60 min at most (120 name-ticks before first fresh, 53 mid-session)");
    const s = withLab.lab!.sessions.find((x) => x.date === "2026-10-05")!;
    expect(notes({ ...s, longest_stale_s: 25, stale_slow_start: undefined })).toContain("stale for 25 s at most;");
    expect(staleSpan(null)).toBe("0 s");
    expect(staleSplit({ ...s, stale_mid_session: null })).toBe("");
  });

  it("names no stock and no contract", () => {
    const section = lab().split('id="options-lab"')[1]!.split('id="research-arms"')[0]!;
    expect(section).not.toMatch(/[A-Z]{1,5}\d{6}[CP]\d{8}/);
    expect(section).not.toContain("AAA");
  });

  it("says the status is not sent yet when the host sends a version 1 document", () => {
    expect(lab(paper())).toContain("The lab&#x27;s tape status is not being sent yet");
  });

  it("gives each state its colour from the rules alone", () => {
    const base = withLab.lab!.sessions[3]!;
    expect(verdict({ ...base, counts: true, shadow: false, partial: false }).tone).toBe("good");
    expect(verdict({ ...base, counts: true, shadow: true }).tone).toBe("warn");
    expect(verdict({ ...base, counts: false, shadow: true }).tone).toBe("bad");
    expect(verdict({ ...base, recorded: false }).label).toBe("Not recorded");
  });
});
