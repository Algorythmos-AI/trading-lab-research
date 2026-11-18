import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PAPER_FRAMES, PaperBody } from "@/components/paper/paper-page";
import { fixturePaperOptions } from "@/lib/fixture-variants";
import type { OptionsClone } from "@/lib/options-clone.types";
import type { OptionsLive } from "@/lib/options-live.types";
import type { PaperOptions } from "@/lib/paper-options.types";
import type { OptionsCloneResult, OptionsLiveResult, PaperOptionsResult } from "@/lib/snapshot";
import cloneJson from "./fixtures/options-clone.v1.json";
import paperJson from "./fixtures/paper-options.v1.json";
import { NON_REAL_FRAMES } from "./env-allowlist";
import { assertOnlyEnvs } from "./env-guard";

// The Paper options page under its heading (DEC-0057), rendered from the fixture: three books that are never added
// together, each total equal to a plain sum of its own rows, and every state the documents can be in.

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
const live = (positions: OptionsLive["positions"] = []): OptionsLiveResult => ({
  status: "ok",
  source: "fixture",
  doc: { schema: "stocksdelta/options-live", schema_version: 3, run_id: "live-1", as_of: "2026-10-12T20:25:00+00:00", paper: true, positions } as unknown as OptionsLive,
});
const render = (
  q: Record<string, string> = {},
  opts: { result?: PaperOptionsResult; clone?: OptionsCloneResult; live?: OptionsLiveResult } = {},
) =>
  renderToStaticMarkup(
    createElement(PaperBody, {
      result: opts.result ?? { status: "ok", doc: paper(), source: "fixture" },
      clone: opts.clone ?? { status: "ok", doc: cloneDoc, source: "fixture" },
      live: opts.live ?? live(),
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

describe("the three books", () => {
  const html = render();
  const d = paper();

  it("each show their own total, equal to a plain sum of their own rows", () => {
    const clone = sum(d.clone.trades.filter((t) => t.counts));
    const manual = sum(d.manual!.trades);
    expect(text(frame(html, PAPER_FRAMES.cloneGlance))).toContain(usd(clone));
    expect(text(frame(html, PAPER_FRAMES.manualGlance))).toContain(usd(manual));
    for (const a of d.arms!) expect(text(frame(html, PAPER_FRAMES.armsGlance))).toContain(usd(sum(a.trades)));
    // The section's headline tile says the same as the card.
    expect(text(frame(html, PAPER_FRAMES.clone))).toContain(`Net result ${usd(clone)}`);
    expect(text(frame(html, PAPER_FRAMES.manual))).toContain(`Net result ${usd(manual)}`);
  });

  it("are never added together", () => {
    const clone = sum(d.clone.trades.filter((t) => t.counts));
    const manual = sum(d.manual!.trades);
    const arms = d.arms!.map((a) => sum(a.trades));
    const all = text(html);
    const blended = [clone + manual, clone + arms.reduce((s, v) => s + v, 0), arms.reduce((s, v) => s + v, 0), clone + manual + arms.reduce((s, v) => s + v, 0)];
    for (const v of blended) expect(all).not.toContain(usd(Math.round(v * 100) / 100).slice(1));
    expect(all).toContain("They are never added together");
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
    expect(links).toEqual(["clone-bot", "my-paper-trades", "research-arms"]);
    expect(links.filter((h) => !all.includes(h))).toEqual([]);
  });

  it("says what the clone's results are after, lists the trade it could not settle, and names no setup", () => {
    const body = text(html);
    expect(body).toContain("After the clone's modelled fee of US$0.03 a contract each way");
    expect(body).toMatch(/1 trade the clone could not settle is in no figure here: \d{4}-\d{2}-\d{2}-O-\d+/);
    expect(body).toContain("Before fees: the paper account charges none.");
    expect(body).not.toMatch(/\b(retest|rejection|reclaim|trap)\b/i);
  });
});

describe("the filters", () => {
  it("cut all three books by ticker, kind and period, and say so when nothing is left", () => {
    const d = paper();
    const spy = render({ s: "SPY" });
    const want = sum(d.clone.trades.filter((t) => t.counts && t.contract.startsWith("SPY")));
    expect(text(frame(spy, PAPER_FRAMES.cloneGlance))).toContain(usd(want));
    expect(spy).toContain('href="/paper?s=SPY&amp;k=call"');
    const calls = render({ k: "call" });
    expect(text(frame(calls, PAPER_FRAMES.cloneGlance))).toContain(usd(sum(d.clone.trades.filter((t) => t.counts && t.side === "call"))));
    const none = text(render({ s: "ZZZZ" }));
    expect(none).toContain("No clone trades in this view");
    expect(none).toContain("No hand-placed trades in this view");
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
  it("still draws today's clone session and the open positions before any history is sent", () => {
    const body = text(render({}, { result: { status: "missing" }, live: live([{ contract: "NVDA261127P00230000", qty: 1, avg_price: 3.4, price: 2.9, market_value: 290, unrealized_pl: -50 }]) }));
    expect(body).toContain("No paper trade history has been sent yet");
    expect(body).toContain("Options clone (paper)");
    expect(body).toContain("NVDA 230 put");
    expect(body).toContain("−US$50.00");
    expect(body).toContain("Your closed paper trades are not being sent yet");
    expect(body).toContain("The arms' simulated trades are not being sent yet");
  });

  it("says storage could not be read, and that the clone and the positions have sent nothing", () => {
    const body = text(render({}, { result: { status: "error" }, clone: { status: "missing" }, live: { status: "missing" } }));
    expect(body).toContain("Storage could not be read");
    expect(body).toContain("No session from the clone yet");
    expect(body).toContain("Open positions have not been sent yet.");
  });

  it("draws the clone alone when the host sends neither the manual account nor the arms", () => {
    const html = render({}, { result: { status: "ok", doc: fixturePaperOptions(paper(), new Set(["partial"])), source: "fixture" } });
    const body = text(html);
    expect(body).toContain("Every clone trade");
    expect(body).toContain("The hand-placed history is not being sent yet.");
    expect(body).toContain("Your closed paper trades are not being sent yet");
    expect(body).toContain("The arms' simulated trades are not being sent yet");
    assertOnlyEnvs(html, ["paper", "shadow"]);
  });

  it("says why the hand-placed section is empty when every fill in the account was the clone's", () => {
    const d = paper();
    d.manual = { ...d.manual!, trades: [], gaps: [], excluded_clone_fills: 34 };
    const body = text(frame(render({}, { result: { status: "ok", doc: d, source: "fixture" } }), PAPER_FRAMES.manual));
    expect(body).toContain("No closed hand-placed trades yet");
    expect(body).toContain("34 fills in this account were the clone bot's own, from when it traded here: they are left out");
    expect(body).not.toContain("Net result");
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
    const stale = text(renderToStaticMarkup(createElement(PaperBody, { result: { status: "ok", doc: paper(), source: "fixture" }, clone: { status: "missing" }, live: live(), q: {}, now: new Date("2026-10-15T14:00:00Z") })));
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
