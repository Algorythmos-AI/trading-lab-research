// Gap Hunter, the stock robot: the names the site gives the host's keys (lib/robots.ts), the page's arithmetic
// (lib/gap-hunter.ts) and the page itself. Every state is derived from the snapshot; what the host does not send is
// said to be missing and never filled in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GapHunterBody } from "@/components/gap-hunter/gap-hunter-page";
import { firing, gapHunterBlock, morningFunnel, records, reliability, runWords, sessionJob, sessionRuns, standing } from "@/lib/gap-hunter";
import { aboutRetiredRule, alertTitle, GAP_HUNTER, hostJobName, isRedAlert, jobName, jobSaid, jobShort, ROBOTS, SESSION_JOBS, siteWords, sortJobKeys } from "@/lib/robots";
import type { Snapshot } from "@/lib/types";
import { fixtureV3 } from "./helpers";

const NOW = new Date("2026-11-20T15:00:00Z");
const snap = (over: Record<string, unknown> = {}) => ({ schema: "trading-lab/snapshot", schema_version: 3, run_id: "r", as_of: "2026-11-20T14:55:00+00:00", ...over }) as unknown as Snapshot;
const job = (status: string, extra: Record<string, unknown> = {}) => ({ jobs: { last: { "paper-s": { status, exit: status === "ok" ? 0 : 1, started: "2026-11-19T13:30:00+00:00", ended: "2026-11-19T21:00:00+00:00", ...extra } } } });
const alert = (key: string, title = "Sleeve S NOT FLAT at the close") => ({ alerts: { firing: [{ key, since: "2026-11-19T21:01:00+00:00", title }] } });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const page = (s: Snapshot | null) => text(renderToStaticMarkup(createElement(GapHunterBody, { s, now: NOW })));

describe("the robots' names", () => {
  it("are exactly three, in one order, and the stock robot is Gap Hunter at /gap-hunter", () => {
    expect(ROBOTS.map((r) => r.name)).toEqual(["Options clone", "Gap Hunter", "Research arms"]);
    expect(GAP_HUNTER).toMatchObject({ name: "Gap Hunter", href: "/gap-hunter", job: "paper-s", alertPrefix: "paper-s:", tag: "S" });
  });

  it("names the host's job keys in one place, and never by the host's own words", () => {
    expect([jobName("paper-s"), jobShort("paper-s"), jobSaid("paper-s")]).toEqual(["Gap Hunter session", "Gap Hunter", "Gap Hunter"]);
    expect(jobName("com.wt.paper-s")).toBe("Gap Hunter session");
    expect([jobName("paper-b"), jobShort("paper-b")]).toEqual(["QQQ rule session (retired)", "QQQ rule"]);
    expect(SESSION_JOBS).toEqual(["routine", "paper-s", "forward"]);
    expect(jobName("something-new")).toBe("something-new");
    // The host's own name for a job is used only for a job the site has no name for.
    expect(hostJobName("com.wt.paper-s", "Sleeve S paper session")).toBe("Gap Hunter session");
    expect(hostJobName("com.wt.paper-b", "Paper B")).toBe("QQQ rule session (retired)");
    expect(hostJobName("com.wt.new-thing", "Sleeve S helper")).toBe("Gap Hunter helper");
    expect(sortJobKeys(["dashboard", "paper-b", "forward", "paper-s", "routine", "paper-o"])).toEqual(["routine", "paper-s", "forward", "dashboard", "paper-b", "paper-o"]);
  });

  it("knows a host line that is about the retired rule", () => {
    expect(aboutRetiredRule("Best candidate: B · QQQ signals, QQQM orders, +0.117R over 415 trades")).toBe(true);
    expect(aboutRetiredRule("Robot B finished normally")).toBe(true);
    expect(aboutRetiredRule("No proven edge yet. Round 3 is cleared to run (DEC-0010 in effect)")).toBe(false);
    expect(aboutRetiredRule(null)).toBe(false);
  });

  it("puts a host line into the site's words: no sleeve, no job key", () => {
    expect(siteWords("Sleeve S paper session (stock desk); scans from the open, flat by the close")).toBe("Gap Hunter paper session (stock desk); scans from the open, flat by the close");
    expect(siteWords("Robot B's sleeve S refused to start")).toBe("Gap Hunter refused to start");
    expect(siteWords("paper-s: a second runner refused to start")).toBe("Gap Hunter: a second runner refused to start");
    expect(siteWords(null)).toBe("");
  });

  it("titles a Gap Hunter alert itself, keeps what follows the key, and leaves other alerts their host title", () => {
    expect(alertTitle("paper-s:not-flat", "Sleeve S NOT FLAT at the close")).toBe("Gap Hunter is not flat after the close");
    expect(alertTitle("paper-s:not-flat:2", "x")).toBe("Gap Hunter is not flat after the close (2)");
    expect(alertTitle("paper-s:brand-new", "Sleeve S did a new thing")).toBe("Gap Hunter alert (brand-new)");
    expect(alertTitle("job:routine", "routine failed")).toBe("routine failed");
    expect(alertTitle("x", null)).toBe("x");
  });

  it("knows which alerts turn the dashboard red", () => {
    for (const k of ["paper-s:not-flat", "paper-s:short", "paper-s:short-at-close", "paper-s:over-caps", "paper-s:orphan", "paper-s:close-unknown", "paper-s:not-paper"]) expect(isRedAlert(k), k).toBe(true);
    for (const k of ["paper-s:lease", "paper-s:clock-skew", "paper-s:stop-rule", "paper-s:refused-keys", "paper-s:refused-account", "paper-s:second-runner", "paper-s:new", "job:routine", "", null]) expect(isRedAlert(k), String(k)).toBe(false);
    // The retired rule's job can still raise its own until it is switched off.
    expect(isRedAlert("paper-b:not-flat")).toBe(true);
    expect(isRedAlert("paper-b:unknown-position:QQQM")).toBe(true);
  });
});

describe("where Gap Hunter stands", () => {
  it("says so when the host has reported nothing, and never calls a session that runs a robot that trades", () => {
    expect(standing(null)).toMatchObject({ word: "No data", tone: "neutral" });
    expect(standing(snap())).toMatchObject({ word: "No session reported yet", tone: "neutral" });
    expect(standing(snap(job("ok")))).toMatchObject({ word: "Session runs", tone: "neutral", detail: "Whether a rule is switched on is not sent yet." });
    expect(standing(snap(job("running")))).toMatchObject({ word: "Session runs" });
  });

  it("reads a refused, failed or timed-out session, an alert, and an urgent alert, worst first", () => {
    expect(standing(snap(job("refused")))).toMatchObject({ word: "Did not start", tone: "warn" });
    expect(standing(snap(job("failed")))).toMatchObject({ word: "Last session did not finish", tone: "warn", detail: "Last session failed." });
    expect(standing(snap(job("timeout")))).toMatchObject({ word: "Last session did not finish", tone: "warn" });
    expect(standing(snap({ ...job("ok"), ...alert("paper-s:lease") }))).toMatchObject({ word: "Needs a look", tone: "warn", detail: "1 alert firing." });
    expect(standing(snap({ ...job("failed"), ...alert("paper-s:not-flat") }))).toMatchObject({ word: "Needs you now", tone: "bad", detail: "1 urgent alert firing." });
  });

  it("says paper trading, paused or latched only when the host's own block says so", () => {
    expect(standing(snap({ ...job("ok"), gap_hunter: { enabled: true } }))).toMatchObject({ word: "Paper trading", tone: "info" });
    expect(standing(snap({ ...job("ok"), gap_hunter: { enabled: false } }))).toMatchObject({ word: "Not switched on", tone: "neutral" });
    expect(standing(snap({ ...job("ok"), gap_hunter: { enabled: true, kill: true } }))).toMatchObject({ word: "Paused: its kill switch is on", tone: "warn" });
    // the root file is the master switch: it stops Gap Hunter even with its own file off
    expect(standing(snap({ ...job("ok"), kill: { on: true }, gap_hunter: { enabled: true, kill: false } }))).toMatchObject({ word: "Paused: the root kill switch is on", tone: "warn" });
    expect(standing(snap({ ...job("ok"), kill: { on: false }, gap_hunter: { enabled: true, kill: false } }))).toMatchObject({ word: "Paper trading" });
    expect(standing(snap({ ...job("ok"), gap_hunter: { enabled: true, latched: true } }))).toMatchObject({ word: "Latched", tone: "bad" });
    // The root kill switch is the master switch: it pauses Gap Hunter here too.
    expect(standing(snap({ ...job("ok"), kill: { on: true } }))).toMatchObject({ word: "Paused: the root kill switch is on", tone: "warn" });
  });

  it("takes the records' statuses from the registry, and says when the registry does not list them", () => {
    expect(records(snap())).toEqual({ decision: { id: "DEC-0068", status: null, date: null }, hypothesis: { id: "HYP-0071", status: null, date: null } });
    const s = snap({ research: { decisions: [{ id: "DEC-0068", status: "PROPOSED", date: "2026-11-20" }], hypotheses: [{ id: "HYP-0071", status: "pre-registered", stale: false }] } });
    expect(records(s)).toEqual({ decision: { id: "DEC-0068", status: "PROPOSED", date: "2026-11-20" }, hypothesis: { id: "HYP-0071", status: "pre-registered", date: null } });
    // A status that is a sentence is prose, and is not shown.
    const prose = snap({ research: { decisions: [{ id: "DEC-0068", status: "x".repeat(41), date: "2026-11-20" }] } });
    expect(records(prose).decision.status).toBeNull();
  });
});

describe("the session job", () => {
  it("reads its last run, its runs newest first, and how often it ran as planned", () => {
    const s = snap({
      ...{ jobs: { last: { "paper-s": { status: "ok", exit: 0, started: "2026-11-19T13:30:00+00:00", ended: "2026-11-19T21:00:00+00:00" } }, runs: [
        { job: "paper-s", status: "refused", exit: 1, started: "2026-11-17T13:30:00+00:00", ended: "2026-11-17T13:30:02+00:00" },
        { job: "com.wt.paper-s", status: "ok", exit: 0, started: "2026-11-19T13:30:00+00:00", ended: "2026-11-19T21:00:00+00:00" },
        { job: "paper-b", status: "ok", exit: 0, started: "2026-11-19T13:30:00+00:00", ended: "2026-11-19T21:00:00+00:00" },
        { job: "paper-s", status: "ok", exit: 0, started: null },
      ] } },
      sla: { summary: [{ job: "paper-b", expected: 10, ok: 8 }, { job: "paper-s", expected: 3, ok: 2, refused: 1, failed: 0, missed: 0 }] },
    });
    expect(sessionJob(s)).toEqual({ status: "ok", exit: 0, started: "2026-11-19T13:30:00+00:00", ended: "2026-11-19T21:00:00+00:00" });
    expect(runWords(sessionJob(s))).toBe("Last session finished normally");
    expect(sessionRuns(s).map((r) => [r.started.slice(0, 10), r.status])).toEqual([["2026-11-19", "ok"], ["2026-11-17", "refused"]]);
    expect(reliability(s)).toEqual({ expected: 3, ok: 2, refused: 1, failed: 0, missed: 0 });
  });

  it("is absent, not late, when the host has reported none", () => {
    expect(sessionJob(snap())).toBeNull();
    expect(runWords(null)).toBe("No session reported yet");
    expect(sessionRuns(snap())).toEqual([]);
    expect(reliability(snap())).toBeNull();
    // The served fixture is the retired rule's world: its job is not Gap Hunter's.
    expect(sessionJob(fixtureV3())).toBeNull();
  });

  it("lists only Gap Hunter's own alerts, urgent first, in the site's words", () => {
    const s = snap({ alerts: { firing: [{ key: "job:routine", title: "routine failed" }, { key: "paper-s:lease", title: "Sleeve S: no primary lease, entries off" }, { key: "paper-s:short", title: "Sleeve S is SHORT" }, { key: "paper-b:not-flat", title: "Paper B NOT FLAT" }] } });
    expect(firing(s).map((a) => [a.key, a.red, a.title])).toEqual([
      ["paper-s:short", true, "Gap Hunter holds a short position"],
      ["paper-s:lease", false, "Gap Hunter has no primary lease: entries are off"],
    ]);
  });
});

describe("the optional block the host is to send", () => {
  it("is null until it is sent, and reads each field on its own", () => {
    expect(gapHunterBlock(null)).toBeNull();
    expect(gapHunterBlock(snap())).toBeNull();
    expect(gapHunterBlock(snap({ gap_hunter: "yes" }))).toBeNull();
    expect(gapHunterBlock(snap({ gap_hunter: { enabled: false, trades: 0, total_r: "1.2", sessions: -1, last_session: "yesterday", funnel: { session: "2026-11-20", kept: 31, passed: 9, tier1: 9, tier2: 4, primary: true } } }))).toEqual({
      enabled: false,
      kill: null,
      latched: null,
      sessions: null,
      lastSession: null,
      trades: 0,
      totalR: null,
      meanR: null,
      open: null,
      funnel: { session: "2026-11-20", kept: 31, passed: 9, tier1: 9, tier2: 4, primary: true },
    });
  });
});

describe("the morning funnel", () => {
  const stage = (stats: Record<string, number>, counts: Record<string, number> = {}) => ({ stage: "tier2", as_of_et: "09:15", stats, counts, tier1: [], tier2: [], primary: null });
  const scanned = (date: string, stats: Record<string, number>) => snap({ market: { trading_day_et: "2026-11-20" }, ops: { routine: { date, stages: [stage(stats)] } } });

  it("is empty with no scan, and never invents a count", () => {
    expect(morningFunnel(null)).toEqual({ source: "none", session: null, current: false, market: [], selection: [] });
    expect(morningFunnel(snap())).toMatchObject({ source: "none", market: [], selection: [] });
  });

  it("shows the scan's own counts as the scan's, with the first pick as yes or no", () => {
    const f = morningFunnel(scanned("2026-11-20", { universe: 4393, snapshot_symbols: 812, kept: 31, n_kept: 31, n_passed: 2, n_tier1: 2, n_chart_ok: 1, n_tier2: 1, n_primary: 0 }));
    expect(f).toMatchObject({ source: "scan", session: "2026-11-20", current: true });
    expect(f.market.map((x) => [x.key, x.value])).toEqual([["universe", 4393], ["traded", 812], ["kept", 31]]);
    expect(f.selection.map((x) => [x.key, x.value])).toEqual([["passed", 2], ["tier1", 2], ["tier2", 1], ["primary", false]]);
    const picked = morningFunnel(scanned("2026-11-19", { universe: 4393, snapshot_symbols: 812, kept: 31, n_kept: 31, n_passed: 2, n_tier1: 2, n_tier2: 1, n_primary: 1 }));
    expect(picked.current).toBe(false);
    expect(picked.selection.at(-1)).toMatchObject({ key: "primary", value: true });
  });

  it("shows only the market's narrowing when an older host sends no selection counts", () => {
    const f = morningFunnel(scanned("2026-11-20", { universe: 4393, snapshot_symbols: 812, kept: 31 }));
    expect(f).toMatchObject({ source: "scan", selection: [] });
    expect(f.market).toHaveLength(3);
  });

  it("puts Gap Hunter's own selection first once the host sends it", () => {
    const s = scanned("2026-11-20", { universe: 4393, snapshot_symbols: 812, kept: 31, n_kept: 31, n_passed: 2, n_tier1: 2, n_tier2: 1, n_primary: 0 });
    (s as unknown as Record<string, unknown>).gap_hunter = { funnel: { session: "2026-11-20", kept: 31, passed: 9, tier1: 9, tier2: 4, primary: true } };
    const f = morningFunnel(s);
    expect(f).toMatchObject({ source: "own", session: "2026-11-20", current: true });
    expect(f.selection.map((x) => [x.key, x.value])).toEqual([["kept", 31], ["passed", 9], ["tier1", 9], ["tier2", 4], ["primary", true]]);
  });
});

describe("the Gap Hunter page", () => {
  it("reads the host's own block from the served fixture, with nothing of the retired rule", () => {
    const body = page(fixtureV3());
    expect(body).toContain("Paper money only");
    expect(body).toContain("Rule DEC-0068 · not in the registry yet");
    expect(body).toContain("No session run in this snapshot");
    expect(body).toContain("No Gap Hunter alert is firing");
    // the fixture's gap_hunter block (scripts/gen_fixture.py GAP_HUNTER): armed three times, one booked trade
    expect(body).toMatch(/A rule is switched on\s+Yes/);
    expect(body).toMatch(/Its kill switch\s+Off/);
    expect(body).toMatch(/Sessions armed\s+3/);
    expect(body).toMatch(/Closed trades\s+1/);
    expect(body).toMatch(/Average R per trade\s+−1\.050R/);
    // Gap Hunter's own selection, in counts
    expect(body).toContain("Morning funnel");
    expect(body).toMatch(/In the morning pool\s+38/);
    expect(body).toMatch(/Tier 2\s+4/);
    expect(body).toContain("First pick: Yes");
    expect(body).not.toMatch(/QQQ|Robot B|sleeve|G1|[Hh]oldout|proven|Virtual|paper-[bs]|US\$/);
    // No candidate's symbol: counts only (the fixture's candidate is LABT, its near misses ZZZA to ZZZC).
    expect(body).not.toMatch(/LABT|ZZZ[ABC]/);
  });

  it("draws the page with no snapshot at all", () => {
    const body = page(null);
    expect(body).toContain("No data");
    expect(body).toContain("No host data");
    expect(body).toContain("No morning funnel has been sent yet");
  });

  it("draws what the host sends once it sends it: the session, its alerts, the registry and its own block", () => {
    const s = snap({
      market: { trading_day_et: "2026-11-20" },
      jobs: { last: { "paper-s": { status: "ok", exit: 0, started: "2026-11-19T13:30:00+00:00", ended: "2026-11-19T21:00:00+00:00" } }, runs: [{ job: "paper-s", status: "ok", exit: 0, started: "2026-11-19T13:30:00+00:00", ended: "2026-11-19T21:00:00+00:00" }] },
      alerts: { firing: [{ key: "paper-s:lease", since: "2026-11-19T13:31:00+00:00", title: "Sleeve S: no primary lease, entries off" }] },
      research: { decisions: [{ id: "DEC-0068", status: "ACCEPTED", date: "2026-11-20" }], hypotheses: [{ id: "HYP-0071", status: "pre-registered" }] },
      sla: { summary: [{ job: "paper-s", expected: 3, ok: 2, refused: 1, failed: 0, missed: 0 }] },
      gap_hunter: { enabled: true, kill: false, sessions: 3, last_session: "2026-11-19", trades: 2, total_r: -0.5, mean_r: -0.25, open: 0, funnel: { session: "2026-11-20", kept: 31, passed: 9, tier1: 9, tier2: 4, primary: true } },
    });
    const body = page(s);
    expect(body).toContain("Rule DEC-0068 · ACCEPTED");
    expect(body).toContain("Needs a look");
    expect(body).toContain("Gap Hunter has no primary lease: entries are off");
    expect(body).toMatch(/A rule is switched on\s+Yes/);
    expect(body).toMatch(/Its kill switch\s+Off/);
    expect(body).toContain("2 of 3 · 1 refused");
    expect(body).toMatch(/Closed trades\s+2/);
    expect(body).toContain("−0.50R");
    expect(body).toMatch(/First pick:\s+Yes/);
    expect(body).not.toMatch(/the pre-market scan's counts|The scan's own counts/);
    expect(body).not.toMatch(/sleeve|paper-s|Robot B|QQQ/i);
  });
});
