"use client";

// The Radar page's pipeline, live: where the session's edition stands in one badge, the stages of the morning's run
// as one rail (each with its state in words and the time it happened), the last twenty sessions, and the Radar's and
// the desk's counts as two separate facts. Drawn from the one summary the page's server render read
// (radar-pipeline-run.ts) by the same pure code the tests run (radar-pipeline.ts), and redrawn here as the clock moves
// on. Nothing here polls: the layout's own refresh, each minute while the tab is visible, brings the next summary and
// the next server time.
import { useSyncExternalStore } from "react";
import { StepRail, type RailState, type RailStep } from "@/components/step-rail";
import { TONE_ICON, TONE_TEXT } from "@/components/status";
import { weekDate } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { sessionOf } from "@/lib/market-calendar";
import {
  type FunnelObs,
  type FunnelStageObs,
  type Headline,
  headlineOf,
  nowBefore,
  type PipelineDays,
  type PipelineFile,
  pipelineDays,
  pipelineStale,
  type Reliability,
  reliabilityOf,
  type SessionMark,
  type SessionObs,
  spanWords,
  type StageRow,
  stageRows,
  type StageState,
  type Who,
} from "@/lib/radar-pipeline";
import { RADAR_STATUS_WORDS, type SelectBlock, shadowView, type ShadowView, topRejects } from "@/lib/select-shadow";
import { cn } from "@/lib/utils";

const SYD = "Australia/Sydney";
const NY = "America/New_York";
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, day: boolean): Intl.DateTimeFormat {
  const key = `${tz}:${day}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...(day ? { weekday: "short" as const } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(key, f);
  }
  return f;
}
/** "21:45" in a zone. */
const hm = (t: number, tz: string) => fmt(tz, false).format(new Date(t));
/** "Mon 21:45" in a zone. */
const dayHm = (t: number, tz: string) => fmt(tz, true).format(new Date(t)).replace(",", "");
/** "Mon 21:45 Sydney (05:45 New York)". */
const both = (t: number) => `${dayHm(t, SYD)} Sydney (${hm(t, NY)} New York)`;

// ---- the clock ------------------------------------------------------------------------------------------------------

/** How often the pipeline is redrawn between two server renders. */
export const PIPELINE_TICK_MS = 10_000;

// The monotonic time each server time first reached this page at. The clock is the server's time plus the time since
// it arrived, never the device's wall clock; the four most recent are kept.
const anchors = new Map<number, number>();
/** The pipeline's clock for a server time, in whole ticks so the same tick reads the same value. */
export function pipelineClock(serverNow: number, perf: number = performance.now()): number {
  let anchor = anchors.get(serverNow);
  if (anchor === undefined) {
    anchor = perf;
    anchors.set(serverNow, anchor);
    while (anchors.size > 4) anchors.delete(anchors.keys().next().value!);
  }
  return serverNow + Math.floor(Math.max(0, perf - anchor) / PIPELINE_TICK_MS) * PIPELINE_TICK_MS;
}
/** For tests: forget every anchor. */
export function resetPipelineClock(): void {
  anchors.clear();
}
const everyTick = (onChange: () => void) => {
  const id = window.setInterval(onChange, PIPELINE_TICK_MS);
  return () => window.clearInterval(id);
};

// ---- words ----------------------------------------------------------------------------------------------------------

const RAIL: Record<StageState, { state: RailState; words: string }> = {
  done: { state: "done", words: "Done" },
  running: { state: "current", words: "Running" },
  waiting: { state: "waiting", words: "Waiting" },
  late: { state: "late", words: "Late" },
  failed: { state: "failed", words: "Failed" },
  not_due: { state: "todo", words: "Not due" },
  no_record: { state: "unknown", words: "No record" },
};

const WHO: Record<Who, string> = { scheduled: "the scheduled run", "catch-up": "the catch-up run", manual: "a run started by hand", unknown: "" };

/** A beacon's closed code, or one of this page's own, in plain words. */
const CODE: Record<string, string> = {
  "no-session": "no session",
  "already-stored": "the edition was already stored",
  "tools-missing": "its tools were missing",
  blocked: "a step was blocked",
  "not-stored": "the site did not store it",
  "late-start": "it started too late",
  "lock-held": "another build holds the lock",
  refused: "the site refused the edition",
  "no-beacon": "no build record",
  "no-receipt": "on file, receipt time not recorded",
  "no-end": "end not recorded",
  quiet: "started, then silent",
  "not-read": "not read yet",
};

/** "4 min after", "2 min before", "on the minute". */
function against(delta: number | null): string {
  if (delta === null) return "";
  if (delta === 0) return "on the minute";
  return `${spanWords(Math.abs(delta))} ${delta > 0 ? "after" : "before"} its time`;
}

export function railSteps(rows: readonly StageRow[]): RailStep[] {
  return rows.map((r) => ({
    key: r.key,
    label: r.short,
    state: RAIL[r.state].state,
    words: RAIL[r.state].words,
    detail: r.at !== null ? hm(r.at, SYD) : r.state === "not_due" || r.state === "waiting" ? `${hm(r.scheduled, SYD)}` : undefined,
  }));
}

/** The sentence beside the badge. Times and counts only. */
export function headlineText(h: Headline, days: PipelineDays, rows: readonly StageRow[], nowMs: number): string {
  const build = rows.find((r) => r.key === "build")!;
  const stored = rows.find((r) => r.key === "stored")!;
  const session = weekDate(days.focus);
  const by = WHO[stored.who] ? ` by ${WHO[stored.who]}` : "";
  const noBuild = build.code === "no-beacon" ? " No build record: the routine sent no run beacon, so who built it is not known." : "";
  switch (h.kind) {
    case "no_session": {
      const today = sessionOf(days.ny_day);
      const why = today.kind === "closed" && today.name ? ` for ${today.name}` : today.kind === "weekend" ? " for the weekend" : "";
      return `New York is shut today${why}. The next session is ${session}; its build starts ${both(build.scheduled)}.`;
    }
    case "schedule_only":
      return `No pipeline record has been written yet, so this is ${session}'s schedule alone. The record is written every ten minutes.`;
    case "on_time":
      return `${session}'s edition was stored ${both(stored.at!)}${by}, inside its deadline of ${hm(stored.deadline, NY)} New York.${noBuild}`;
    case "by_hand":
      return `${session}'s edition was stored ${both(stored.at!)} by a run a person started${h.late_min !== null ? `, ${spanWords(h.late_min)} behind its time and past its deadline of ${hm(stored.deadline, NY)} New York` : ""}.`;
    case "late":
      return stored.at !== null
        ? `${session}'s edition was stored ${both(stored.at)}${by}. It was due about ${hm(stored.scheduled, NY)} and no later than ${hm(stored.deadline, NY)} New York.${noBuild}`
        : `${session}'s edition is not stored. It was due about ${hm(stored.scheduled, NY)} and no later than ${hm(stored.deadline, NY)} New York (${dayHm(stored.deadline, SYD)} Sydney).${build.state === "running" ? " A build is running." : noBuild}`;
    case "failed":
      return stored.code === "refused"
        ? `The site refused ${session}'s edition at ${both(stored.at ?? nowMs)} and nothing has been stored since.`
        : `${session}'s ${build.state === "failed" ? "build" : "send"} said it failed: ${CODE[(build.state === "failed" ? build.code : stored.code) ?? ""] ?? "no reason given"}. No edition is stored.`;
    case "building":
      return `${session}'s edition is being built${WHO[build.who] ? ` by ${WHO[build.who]}` : ""}. It is due by ${both(stored.deadline)}.`;
    case "not_due":
      return `Next: ${session}. The build starts ${both(build.scheduled)}, in ${spanWords((build.scheduled - nowMs) / 60_000)}.`;
    case "waiting":
      return stored.state === "no_record"
        ? `${session}'s edition is on file, but when the store received it is not recorded.`
        : `${session}'s build time has passed and no edition is stored yet. It is due by ${both(stored.deadline)}.${noBuild}`;
  }
}

const BADGE: Record<Headline["tone"], string> = {
  good: "bg-good-soft text-good border-good/40",
  warn: "bg-warn-soft text-warn border-warn/40",
  bad: "bg-bad-soft text-bad border-bad/40",
  info: "bg-info-soft text-info border-info/40",
  neutral: "bg-muted text-foreground border-border",
};

const MARK: Record<SessionMark, { cell: string; words: string }> = {
  on_time: { cell: "bg-good-fill", words: "on time" },
  late: { cell: "bg-warn-fill", words: "late" },
  by_hand: { cell: "bg-info-fill", words: "built by hand" },
  missed: { cell: "bg-bad-fill", words: "never stored" },
  no_record: { cell: "border-border border border-dashed", words: "no record" },
  pending: { cell: "border-border border border-dashed", words: "not yet" },
};

// ---- the parts ------------------------------------------------------------------------------------------------------

function ReliabilityStrip({ r }: { r: Reliability }) {
  const n = r.marks.length;
  const parts = [
    [r.on_time, "on time"],
    [r.late, "late"],
    [r.by_hand, "by hand"],
    [r.missed, "never stored"],
    [r.no_record, "no record"],
  ] as const;
  const summary = parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(", ");
  const rate = r.rate === null ? null : Math.round(r.rate * 100);
  const tone: Tone = rate === null ? "neutral" : rate >= 90 ? "good" : rate >= 70 ? "warn" : "bad";
  return (
    <section aria-label="The last sessions" className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Last {n} sessions</h3>
        <span data-on-time-rate className={cn("font-mono text-lg font-semibold tabular-nums", TONE_TEXT[tone])}>
          {rate === null ? "No record yet" : `${rate}% on time`}
        </span>
        {rate !== null ? (
          <span data-on-time-n className="text-muted-foreground font-mono text-xs tabular-nums" title={'Sessions with "no record" are left out of the rate.'}>
            n={r.counted}
            {r.no_record > 0 ? ` of ${n}` : ""}
          </span>
        ) : null}
        {summary ? <span className="text-muted-foreground text-xs">{summary}</span> : null}
      </div>
      <div className="flex items-center gap-1" role="img" aria-label={`The last ${n} sessions, oldest first: ${summary || "no record yet"}`}>
        {r.marks.map((m) => (
          <span key={m.session} data-mark={m.mark} title={`${weekDate(m.session)}: ${MARK[m.mark].words}`} className={cn("h-4 flex-1 rounded-[2px]", MARK[m.mark].cell)} />
        ))}
      </div>
      <ul className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] max-sm:text-xs" aria-hidden>
        {(["on_time", "late", "by_hand", "missed", "no_record"] as const).map((k) => (
          <li key={k} className="inline-flex items-center gap-1">
            <span className={cn("inline-block size-2.5 rounded-[2px]", MARK[k].cell)} />
            {MARK[k].words}
          </li>
        ))}
      </ul>
    </section>
  );
}

const EVIDENCE: Record<FunnelStageObs["evidence"], { tone: Tone; words: string }> = {
  present: { tone: "good", words: "Evidence kept" },
  missing: { tone: "bad", words: "Evidence missing" },
  broken: { tone: "bad", words: "Evidence does not check" },
};
const REPLAY: Record<FunnelStageObs["replay"], { tone: Tone; words: string }> = {
  match: { tone: "good", words: "Replay matches" },
  mismatch: { tone: "bad", words: "Replay differs" },
  not_run: { tone: "neutral", words: "Replay not run" },
};

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium", tone === "good" && "border-good-fill/50 bg-good-soft", tone === "bad" && "border-bad-fill/70 bg-bad-soft", tone === "neutral" && "border-border bg-card")}>
      <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} />
      {children}
    </span>
  );
}

/**
 * Two facts, side by side and never one funnel. The Radar count is the previous morning's edition (the funnel's
 * health document reads the Radar of the session the focus was picked after); the desk count is the Options desk's
 * fixed list, judged after the close. The desk's names are not drawn from the Radar's.
 */
function FunnelCard({ session, radarMorning, funnel }: { session: string; radarMorning: string; funnel: FunnelObs | null }) {
  const radar = funnel?.radar ?? null;
  const focus = funnel?.focus ?? null;
  return (
    <section aria-label="Radar scan and desk pick" data-funnel-card className="border-border grid gap-2 rounded-lg border p-3">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Radar scan and desk pick for {weekDate(session)}</h3>
      {funnel ? (
        <>
          <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Two separate counts">
            <li data-radar-scanned className="border-border rounded-lg border px-2 py-2">
              <div className="text-sm">
                Radar scanned <span className="font-mono text-lg font-semibold tabular-nums">{radar?.kept ?? "—"}</span>
              </div>
              <div className="text-muted-foreground text-xs leading-tight">{`morning of ${weekDate(radarMorning)}`}</div>
            </li>
            <li data-desk-picked className="border-border rounded-lg border px-2 py-2">
              <div className="text-sm">
                Desk <span className="font-mono text-lg font-semibold tabular-nums">{focus?.judged ?? "—"}</span> →{" "}
                <span className="font-mono text-lg font-semibold tabular-nums">{focus?.kept ?? "—"}</span> picked
              </div>
              <div className="text-muted-foreground text-xs leading-tight">the desk&apos;s fixed list, after the close</div>
            </li>
          </ul>
          <p className="text-muted-foreground text-xs">The desk&apos;s names are its own fixed list; they are not drawn from the Radar&apos;s names.</p>
          <div className="flex flex-wrap gap-1.5">
            {radar ? <Chip tone={EVIDENCE[radar.evidence].tone}>Radar: {EVIDENCE[radar.evidence].words.toLowerCase()}</Chip> : <Chip tone="neutral">Radar: no record</Chip>}
            {focus ? <Chip tone={EVIDENCE[focus.evidence].tone}>Focus pick: {EVIDENCE[focus.evidence].words.toLowerCase()}</Chip> : <Chip tone="neutral">Focus pick: no record</Chip>}
            {focus ? <Chip tone={REPLAY[focus.replay].tone}>{REPLAY[focus.replay].words}</Chip> : null}
            {focus && focus.flagged > 0 ? <Chip tone="neutral">{focus.flagged} flagged</Chip> : null}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">No record of the Radar scan or the desk pick for this session yet. It arrives after the evening&apos;s focus pick.</p>
      )}
    </section>
  );
}

const SHADOW_STATE: Record<ShadowView["state"], { tone: Tone; words: string }> = {
  ran: { tone: "good", words: "Ran" },
  not_due: { tone: "neutral", words: "Not due yet" },
  running: { tone: "neutral", words: "Running" },
  overdue: { tone: "bad", words: "No run recorded" },
  off: { tone: "neutral", words: "Switched off on the host" },
  no_record: { tone: "neutral", words: "No record" },
};

const n = (v: number | null | undefined) => (typeof v === "number" ? String(v) : "—");

/**
 * The Radar → Options shadow (DEC-0070): the same session's Radar candidates through the gate into the desk's frozen
 * Stage 1 rules, run on the host at 06:45 New York. Counts and codes only, never a name, and never the published focus:
 * it is drawn apart from the stages above and changes neither the headline nor the on-time record.
 */
function ShadowCard({ view }: { view: ShadowView }) {
  const r = view.run;
  const st = SHADOW_STATE[view.state];
  return (
    <section aria-label="Shadow selection" data-shadow-card data-shadow-state={view.state} className="border-border grid gap-2 rounded-lg border border-dashed p-3">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Shadow selection for {weekDate(view.session)} · not the published focus
      </h3>
      {r ? (
        <>
          <ul className="grid gap-1.5 sm:grid-cols-3" aria-label="Shadow stages">
            <li data-shadow-stage="candidates" className="border-border rounded-lg border px-2 py-2">
              <div className="text-sm">
                Candidates <span className="font-mono text-lg font-semibold tabular-nums">{n(r.candidates.discovered)}</span>
              </div>
              <div className="text-muted-foreground text-xs leading-tight">
                {`new to the desk, of ${n(r.candidates.in_scope_symbols)} on the Radar's options lists`}
              </div>
            </li>
            <li data-shadow-stage="universe" className="border-border rounded-lg border px-2 py-2">
              <div className="text-sm">
                Gate <span className="font-mono text-lg font-semibold tabular-nums">{n(r.universe.admitted)}</span> of{" "}
                <span className="font-mono tabular-nums">{n(r.universe.candidates_gated)}</span> kept
              </div>
              <div className="text-muted-foreground text-xs leading-tight">
                {topRejects(r.universe.rejected).map((x) => `${x.code.replaceAll("_", " ")} ${x.count}`).join(" · ") || "nothing rejected"}
              </div>
            </li>
            <li data-shadow-stage="stage1" className="border-border rounded-lg border px-2 py-2">
              <div className="text-sm">
                Stage 1 <span className="font-mono text-lg font-semibold tabular-nums">{n(r.stage1.ranked)}</span> →{" "}
                <span className="font-mono text-lg font-semibold tabular-nums">{n(r.stage1.picked)}</span> picked
              </div>
              <div className="text-muted-foreground text-xs leading-tight">
                {r.picks_from_radar > 0 ? `${r.picks_from_radar} from the Radar` : "all from the desk's 12"}
              </div>
            </li>
          </ul>
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={r.radar_status === "ok" ? "good" : "neutral"}>{RADAR_STATUS_WORDS[r.radar_status ?? ""] ?? "Radar: no status"}</Chip>
            {r.gate_unset ? <Chip tone="neutral">Gate thresholds not set: no Radar name can join yet</Chip> : null}
            {r.late ? <Chip tone="bad">Late: after 08:40 New York</Chip> : null}
            {!r.radar_bars_ok ? <Chip tone="bad">The candidates&apos; bars could not be fetched</Chip> : null}
            {r.finished_at ? <Chip tone="neutral">Finished {both(Date.parse(r.finished_at))}</Chip> : null}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={st.tone}>{st.words}</Chip>
          <span className="text-muted-foreground text-xs">
            {view.state === "not_due" && view.startsAt !== null
              ? `It runs on the trading host at ${both(view.startsAt)}.`
              : view.state === "no_record"
                ? "The trading host has not sent a shadow record for this session."
                : view.state === "off"
                  ? "The host's off switch is set; it runs nothing until it is removed."
                  : view.state === "running"
                    ? "It reads the Radar until 07:45 New York, then runs once."
                    : "The host sent no run for this session."}
          </span>
        </div>
      )}
      <p className="text-muted-foreground text-xs">A shadow run: it publishes nothing. The Options page&apos;s four names are still the after-close pick.</p>
    </section>
  );
}

function StageList({ rows }: { rows: readonly StageRow[] }) {
  return (
    <details className="group">
      <summary className="text-muted-foreground cursor-pointer text-xs font-medium">Each stage: scheduled against actual</summary>
      <ul className="mt-2 grid gap-1.5" aria-label="Each stage, scheduled against actual">
        {rows.map((r) => {
          const said = [against(r.delta_min), WHO[r.who] ? `by ${WHO[r.who]}` : "", r.code ? (CODE[r.code] ?? "") : ""].filter(Boolean).join(" · ");
          return (
            <li key={r.key} className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md border px-2.5 py-1.5 text-sm">
              <span className="font-medium">{r.label}</span>
              <span className="text-muted-foreground text-xs">{RAIL[r.state].words}</span>
              <span className="ml-auto font-mono text-xs tabular-nums">
                {r.at !== null ? `${both(r.at)}` : "—"}
              </span>
              <span className="text-muted-foreground w-full text-xs">
                Scheduled {both(r.scheduled)}
                {r.key !== "open" && r.key !== "build" ? `, due by ${hm(r.deadline, NY)} New York` : ""}
                {said ? ` · ${said}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Everything the pipeline draws at `nowMs`: pure, so a test can draw every state. */
export function pipelineView(file: PipelineFile | null, nowMs: number) {
  const days = pipelineDays(nowMs);
  const obs: SessionObs | null = file?.sessions.find((s) => s.session === days.focus) ?? null;
  const rows = stageRows(days.focus, obs, nowMs);
  const headline = headlineOf(days, obs, rows, nowMs, file === null);
  return { days, obs, rows, headline, text: headlineText(headline, days, rows, nowMs), reliability: reliabilityOf(days, file, nowMs), stale: pipelineStale(file, nowMs), mark: nowBefore(rows, nowMs) };
}

export function RadarPipelineView({ file, nowMs, shadow }: { file: PipelineFile | null; nowMs: number; shadow?: SelectBlock | null }) {
  const v = pipelineView(file, nowMs);
  return (
    <div className="grid gap-4" data-radar-pipeline data-headline={v.headline.kind}>
      <div className="flex flex-wrap items-center gap-2" role="status" aria-label={`Radar pipeline: ${v.headline.word}`}>
        <span className={cn("rounded-lg border px-3 py-1.5 text-base font-semibold", BADGE[v.headline.tone])}>{v.headline.word}</span>
        <span className="text-sm">{v.text}</span>
      </div>
      {v.stale && file ? (
        <p data-pipeline-stale className="border-warn/60 bg-warn-soft rounded-lg border p-2 text-xs">
          This record was last written {both(Date.parse(file.generated_at))}, {spanWords((nowMs - Date.parse(file.generated_at)) / 60_000)} ago. It is written every ten minutes, so what it shows may be behind.
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <StepRail label={`The Radar pipeline for ${weekDate(v.days.focus)}`} steps={railSteps(v.rows)} nowBefore={v.mark} />
        <p className="text-muted-foreground text-center text-[0.6875rem] max-sm:text-xs">
          Times are Sydney: when a stage happened, or when it is due.{v.mark !== null ? " The blue dot is now." : ""}
        </p>
      </div>
      <StageList rows={v.rows} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ReliabilityStrip r={v.reliability} />
        <FunnelCard session={v.days.focus} radarMorning={v.days.previous} funnel={v.obs?.funnel ?? null} />
      </div>
      {shadow !== undefined ? <ShadowCard view={shadowView(shadow, v.days.focus, nowMs)} /> : null}
    </div>
  );
}

/** The pipeline on the Radar page. `serverNow` is the server render's clock (ms). */
export function RadarPipelineLive({ file, serverNow, shadow }: { file: PipelineFile | null; serverNow: number; shadow?: SelectBlock | null }) {
  // Null in the server render and through hydration: the server's own time, so both draw the same thing.
  const now = useSyncExternalStore(everyTick, () => pipelineClock(serverNow), () => null) ?? serverNow;
  return <RadarPipelineView file={file} nowMs={now} shadow={shadow} />;
}
