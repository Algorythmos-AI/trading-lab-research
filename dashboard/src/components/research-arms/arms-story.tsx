// The Research arms page under its heading: the whole story of the options clone's research arms (DEC-0041,
// EXP-0030), from registration to the no-verdict close, and what replaced them (the options lab, DEC-0060 and
// DEC-0067). Server-rendered; apart from the page file so a test can render it.
//
// The story's dates and rules are fixed facts of the records (lib/research-arms.ts). The figures are live, from the
// Paper options document: the shadow arms' simulated trades inside their window, one book per arm and never added
// together, and the lab's tape status. The tag arms show no figure at all: none exists before their reports.
import { ArrowUpRight, CalendarClock, CircleCheck, CircleHelp, CircleDot, Circle, Database, FlaskConical, GitBranch, Layers, ListChecks, Lock, Scale, Sigma } from "lucide-react";
import Link from "next/link";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { PaperTable } from "@/components/client/paper-table";
import { Empty } from "@/components/empty";
import { Meter } from "@/components/meter";
import { ANCHOR_MARGIN, Panel } from "@/components/panel";
import { Dollars } from "@/components/paper/dollars";
import { verdict as labVerdict } from "@/components/paper/lab-tape";
import { EnvFrame } from "@/components/ui/env-chip";
import { Sparkline } from "@/components/v3/sparkline";
import { nyTime, summarize } from "@/lib/journal";
import { armBooks, MIN_SAMPLE, paperRows, paperStale, premiumStats, ropHistogram, type ArmBook } from "@/lib/paper";
import type { PaperOptions } from "@/lib/paper-options.types";
import {
  armCurve,
  armProgress,
  COUNT,
  FIRST_READ,
  gateTrack,
  heatmap,
  insideWindow,
  labProgress,
  MILESTONES,
  milestoneStates,
  recordHref,
  TRIALS,
  WINDOW,
  WINDOW_SESSIONS,
  wireStates,
  type ArmTrial,
  type LabProgress,
} from "@/lib/research-arms";
import type { PaperOptionsResult } from "@/lib/snapshot";
import { cn } from "@/lib/utils";
import { DescriptiveBand } from "./band";
import { GateTracker } from "./gate-tracker";
import { SessionHeatmap } from "./heatmap";
import { Lineage } from "./lineage";
import { Pipeline } from "./pipeline";
import { VerdictTest } from "./verdict-test";

/** The one non-real frame this page draws (test/env-allowlist.ts lists it). */
export const ARMS_FRAME = "Research arms, simulated detail";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "5 Nov 2026" from "2026-11-05". */
export const dayWords = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
const share = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const signedPct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}%`);
const textTone = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "" : v > 0 ? "text-good" : "text-bad");

function RecordLink({ id }: { id: string }) {
  return (
    <Link href={recordHref(id)} className="hover:text-foreground focus-visible:outline-ring font-mono underline decoration-dotted underline-offset-2 focus-visible:outline-2">
      {id}
    </Link>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn(ANCHOR_MARGIN, "grid min-w-0 gap-4")}>
      <div className="grid gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">{intro}</p>
      </div>
      {children}
    </section>
  );
}

// ── The hero ─────────────────────────────────────────────────────────────────────────────────────────────────────

type ChipTone = "bad" | "warn" | "good" | "info" | "neutral";
const CHIP: Record<ChipTone, string> = {
  bad: "bg-bad-soft text-bad",
  warn: "bg-warn-soft text-warn",
  good: "bg-good-soft text-good",
  info: "bg-info-soft text-info",
  neutral: "bg-muted text-foreground",
};

function Fact({ label, value, hint, tone = "neutral" }: { label: string; value: React.ReactNode; hint?: string; tone?: ChipTone }) {
  return (
    <div className={cn("grid content-start gap-0.5 rounded-lg px-3 py-2.5", CHIP[tone])}>
      <dt className="text-[0.6875rem] font-medium tracking-wide uppercase opacity-80 max-sm:text-xs">{label}</dt>
      <dd className="text-base font-semibold">{value}</dd>
      {hint ? <dd className="text-[0.75rem] leading-snug opacity-80">{hint}</dd> : null}
    </div>
  );
}

function Hero() {
  return (
    <div className="bg-card grid gap-4 rounded-xl border p-4 sm:p-5" data-arms-hero="">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="bg-bad-soft text-bad inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold">
          <span aria-hidden className="bg-bad-fill size-2 rounded-full" />
          Ended
        </span>
        <span className="bg-warn-soft text-warn rounded-full px-2.5 py-1 font-semibold">No verdict</span>
        <span className="text-muted-foreground">
          14 trials · <RecordLink id="DEC-0041" /> · <RecordLink id="EXP-0030" />
        </span>
      </div>
      <p className="max-w-prose text-[0.9375rem] leading-relaxed">
        Fourteen variations of the options clone&apos;s rules ran beside it from {dayWords(WINDOW.from)}: ten as flags on its own decisions, four as simulated trades. A change to the control&apos;s rules
        ended them all after {dayWords(WINDOW.last)}, too early for any to reach a verdict. They close on {dayWords(WINDOW.close)} with none.
      </p>
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Fact label="Window" value="5–17 Nov 2026" hint={`${WINDOW_SESSIONS.length} market sessions, the most any arm could have`} tone="info" />
        <Fact label="Needed for a verdict" value={`${COUNT.units} trades · ${COUNT.sessions} sessions`} hint="None can reach it" tone="warn" />
        <Fact label="Closes" value={dayWords(WINDOW.close)} hint="With no verdict" tone="bad" />
        <Fact label="The control" value="Untouched by the arms" hint="No order sent; no decision of the clone changed" tone="good" />
      </dl>
    </div>
  );
}

// ── The timeline ─────────────────────────────────────────────────────────────────────────────────────────────────

function Timeline({ today, lab }: { today: string; lab: LabProgress | null }) {
  const states = milestoneStates(today, lab);
  return (
    <ol className="relative grid gap-0" aria-label="From the arms' registration to their close">
      {MILESTONES.map((m, i) => {
        const s = states[i]!;
        const Icon = s === "done" ? CircleCheck : s === "next" ? CircleDot : s === "unknown" ? CircleHelp : Circle;
        const live =
          lab && m.key === "counting"
            ? `Shadow sessions: ${lab.shadowDone} of ${lab.shadowNeeded}.`
            : lab && m.key === "tables"
              ? `Counted so far: ${lab.counted} of ${FIRST_READ}.`
              : s === "unknown"
                ? "Not known: the lab's status is not in the document."
                : null;
        return (
          <li key={m.key} className="grid grid-cols-[1.5rem_1fr] gap-x-3" data-milestone={s}>
            <div className="flex flex-col items-center">
              <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", s === "done" ? "text-good" : s === "next" ? "text-info" : "text-muted-foreground")} />
              {i < MILESTONES.length - 1 ? <span aria-hidden className="bg-border my-1 w-px grow" /> : null}
            </div>
            <div className="grid gap-1 pb-5">
              <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                <span className="font-mono">{m.date ? dayWords(m.date) : "When the lab gets there"}</span>
                <span className={cn("rounded px-1.5 py-px text-[0.6875rem] font-medium max-sm:text-xs", m.track === "arms" ? "bg-warn-soft text-warn" : "bg-info-soft text-info")}>
                  {m.track === "arms" ? "Arms" : "Lab"}
                </span>
                <span className="sr-only">{s === "done" ? "Done." : s === "next" ? "Next." : s === "unknown" ? "Not known." : "Later."}</span>
                {s === "next" ? <span className="text-info font-medium">Next</span> : null}
              </p>
              <p className="font-medium">{m.title}</p>
              <p className="text-muted-foreground max-w-prose text-sm">
                {m.detail}
                {live ? <span className="text-foreground"> {live}</span> : null}
              </p>
              <p className="flex flex-wrap gap-2 text-xs">
                {m.records.map((r) => (
                  <RecordLink key={r} id={r} />
                ))}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── The fourteen trials ──────────────────────────────────────────────────────────────────────────────────────────

function TrialCard({ t, book, sent }: { t: ArmTrial; book: ArmBook | null; sent: boolean }) {
  const p = book ? armProgress(book.trades) : null;
  return (
    <li className="bg-card grid content-start gap-2.5 rounded-lg border p-3.5" data-trial={t.hyp} data-kind={t.kind}>
      <div className="flex items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <RecordLink id={t.hyp} />
          <p className="text-sm font-medium">{t.label}</p>
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold max-sm:text-xs", t.kind === "tag" ? "bg-muted text-foreground" : "bg-info-soft text-info")}>
          {t.kind === "tag" ? "Tag" : "Shadow"}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {t.base ? (
          <>
            On the control&apos;s <span className="font-mono">{t.base}</span> trades
          </>
        ) : (
          "Its own trigger"
        )}
 · tests the {t.compares}
      </p>
      {t.kind === "tag" ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-[0.8125rem]">
          <Lock aria-hidden className="size-3.5 shrink-0" />
          Result sealed until its report
        </p>
      ) : (
        <div className="grid gap-2">
          <Meter label="Trades" value={p?.trades ?? null} max={COUNT.units} valueText={p ? `${p.trades} of ${COUNT.units}` : "—"} tone={p && p.tradeShare >= 1 ? "good" : "info"} />
          <Meter label="Sessions" value={p?.sessions ?? null} max={COUNT.sessions} valueText={p ? `${p.sessions} of ${COUNT.sessions}` : "—"} tone={p && p.sessionShare >= 1 ? "good" : "warn"} />
          {sent ? (
            <a href={`#arm-${t.hyp}`} className="hover:text-foreground text-muted-foreground inline-flex min-h-11 items-center gap-1 text-xs underline-offset-2 hover:underline sm:min-h-0">
              Its simulated trades
              <ArrowUpRight aria-hidden className="size-3" />
            </a>
          ) : null}
        </div>
      )}
    </li>
  );
}

// ── One shadow arm in detail ─────────────────────────────────────────────────────────────────────────────────────

function Spread({ book }: { book: ArmBook }) {
  const bands = ropHistogram(book);
  const most = Math.max(1, ...bands.map((b) => b.trades));
  return (
    <ol className="grid gap-1" aria-label={`${book.hyp}: simulated trades by result on the premium paid`}>
      {bands.map((b) => (
        <li key={b.key} className="grid grid-cols-[7.5rem_1fr_2rem] items-center gap-2 text-xs">
          <span className="text-muted-foreground">{b.label}</span>
          <span className="bg-muted h-2.5 overflow-hidden rounded-full">
            <span className={cn("block h-full rounded-full", b.loss ? "bg-bad-fill" : "bg-good-fill")} style={{ width: `${(b.trades / most) * 100}%` }} />
          </span>
          <span className="text-right font-mono">{b.trades}</span>
        </li>
      ))}
    </ol>
  );
}

function ArmDetail({ t, book }: { t: ArmTrial; book: ArmBook }) {
  const s = summarize(book.trades);
  const prem = premiumStats(book);
  const curve = armCurve(book.trades);
  const enough = s.trades >= MIN_SAMPLE;
  return (
    <Panel
      id={`arm-${t.hyp}`}
      title={
        <>
          <span className="font-mono">{t.hyp}</span>
          <span className="text-muted-foreground font-normal">· {t.label}</span>
        </>
      }
      icon={FlaskConical}
      means={`${t.base ? `A simulated variation on the control's ${t.base} trades` : "A simulated trigger of its own"}, one contract a trade, after the same modelled fees as the clone. Its own trial: not added to any other arm.`}
    >
      {book.trades.length === 0 ? (
        <Empty title="No simulated trade in its window">This arm booked no closed trade from 5 to 17 Nov 2026.</Empty>
      ) : (
        <div className="grid gap-5">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground text-xs">Simulated trades</dt>
              <dd className="font-mono text-lg font-semibold">{s.trades}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Result, one contract each</dt>
              <dd className={cn("font-mono text-lg font-semibold", textTone(s.net))}>
                <Dollars env="shadow" value={s.net} signed />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Won</dt>
              <dd className="font-mono text-lg font-semibold">{enough ? share(s.winRate) : "—"}</dd>
              {!enough ? <dd className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">From {MIN_SAMPLE} trades</dd> : null}
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Average on the premium</dt>
              <dd className={cn("font-mono text-lg font-semibold", textTone(prem.mean))}>{signedPct(prem.mean)}</dd>
              {prem.mean === null ? <dd className="text-muted-foreground text-[0.6875rem] max-sm:text-xs">From {MIN_SAMPLE} trades</dd> : null}
            </div>
          </dl>
          <div className="grid gap-5 md:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <p className="text-muted-foreground text-xs font-medium">Running total, day by day</p>
              <div className={textTone(s.net)}>
                {curve.length > 2 ? <Sparkline values={curve} label={`${t.hyp}: running total of its simulated trades`} className="h-16 w-full" height={64} /> : <p className="text-muted-foreground text-xs">— (one day only)</p>}
              </div>
            </div>
            <div className="grid content-start gap-1.5">
              <p className="text-muted-foreground text-xs font-medium">How the results are spread</p>
              <Spread book={book} />
            </div>
          </div>
          {book.truncated > 0 || book.skipped > 0 ? (
            <p className="text-warn text-xs">
              {book.truncated > 0 ? `${book.truncated} older ${book.truncated === 1 ? "trade was" : "trades were"} left out of the document by its cap. ` : ""}
              {book.skipped > 0 ? `${book.skipped} ${book.skipped === 1 ? "row" : "rows"} could not be read and ${book.skipped === 1 ? "is" : "are"} left out.` : ""}
            </p>
          ) : null}
          <details className="rounded-md border px-3 py-2" data-arm-trades={t.hyp}>
            <summary className="hover:text-foreground cursor-pointer text-sm font-medium max-sm:min-h-11 max-sm:content-center">Every simulated trade ({s.trades})</summary>
            <div className="mt-3">
              <PaperTable rows={paperRows(book)} env="shadow" label={`Simulated trades of ${t.hyp}`} />
            </div>
          </details>
        </div>
      )}
    </Panel>
  );
}

function ShadowDetail({ books, unread }: { books: ArmBook[] | null; unread: boolean }) {
  const shadow = TRIALS.filter((t) => t.kind === "shadow");
  return (
    <EnvFrame env="shadow" label={ARMS_FRAME} className="grid gap-4">
      {unread ? (
        <Empty icon={Database} title="The arms' simulated trades could not be read">
          Storage did not answer. Reload in a minute.
        </Empty>
      ) : books === null ? (
        <Empty icon={Database} title="The arms' simulated trades are not being sent yet">
          The trading host sends them with the paper options history. Until it does, the meters above read —.
        </Empty>
      ) : books.length === 0 ? (
        <Empty icon={Database} title="No simulated trade from 5 to 17 Nov 2026">
          The shadow arms booked no closed trade inside their window.
        </Empty>
      ) : (
        shadow.map((t) => {
          const book = books.find((b) => b.hyp === t.hyp);
          return book ? <ArmDetail key={t.hyp} t={t} book={book} /> : null;
        })
      )}
      <p className="text-muted-foreground max-w-prose text-xs">
        Simulated fills at the quoted prices, never orders. Each arm is its own trial, so the arms are shown one by one and never added up. A rate or an average is shown from {MIN_SAMPLE} trades.
      </p>
    </EnvFrame>
  );
}

// ── Where the research went ──────────────────────────────────────────────────────────────────────────────────────

function LabCard({ doc, lab, unread }: { doc: PaperOptions | null; lab: LabProgress | null; unread: boolean }) {
  const latest = doc?.lab?.sessions?.at(-1) ?? null;
  const v = latest ? labVerdict(latest) : null;
  return (
    <Panel
      id="where-it-went"
      title="Where the research went"
      icon={GitBranch}
      means="The arms were replaced by the options lab: a recording of the focus names' option quotes on the trading host, to measure real stop hits, round-trip costs and fills. It places no trade and tests no setup."
    >
      <div className="grid gap-4">
        {lab ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Meter label="Shadow sessions" value={lab.shadowDone} max={lab.shadowNeeded} valueText={`${lab.shadowDone} of ${lab.shadowNeeded}`} tone={lab.shadowLeft === 0 ? "good" : "warn"} />
              <Meter label={`Counted sessions, first tables at ${FIRST_READ}`} value={lab.counted} max={FIRST_READ} valueText={`${lab.counted} of ${FIRST_READ}`} tone={lab.toFirstRead === 0 ? "good" : "info"} />
            </div>
            <dl className="text-muted-foreground grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs">Recorder v2 since</dt>
                <dd className="text-foreground font-mono">{lab.firstV2 ? dayWords(lab.firstV2) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs">Sessions recorded</dt>
                <dd className="text-foreground font-mono">{lab.recorded}</dd>
              </div>
              <div>
                <dt className="text-xs">Archived</dt>
                <dd className="text-foreground font-mono">{lab.archived}</dd>
              </div>
              <div>
                <dt className="text-xs">Latest session</dt>
                <dd className={cn("font-medium", v ? (v.tone === "good" ? "text-good" : v.tone === "warn" ? "text-warn" : "text-bad") : "text-foreground")}>
                  {latest && v ? `${dayWords(latest.date)}: ${v.label}` : "—"}
                </dd>
              </div>
            </dl>
            <p className="text-muted-foreground text-xs">
              Stage 1, recording, runs now. Stage 2, the first tables, comes at {FIRST_READ} counted sessions (<RecordLink id="EXP-0052" />
              ). {lab.shadowLeft > 0 ? `${lab.shadowLeft} shadow ${lab.shadowLeft === 1 ? "session is" : "sessions are"} left before counting starts.` : "The shadow period is over; sessions now count."}
            </p>
          </>
        ) : (
          <Empty icon={Database} title={unread ? "The lab's tape status could not be read" : "The lab's tape status is not being sent yet"}>
            {unread ? "Storage did not answer. Reload in a minute." : "Once the trading host sends it, its shadow sessions and its progress toward the first tables show here."}
          </Empty>
        )}
        <nav aria-label="Related pages" className="flex flex-wrap gap-2 text-sm">
          {[
            { href: "/paper#options-lab", label: "The lab's daily tape" },
            { href: "/paper#arms-table", label: "Arms on the Paper page" },
            { href: "/research", label: "Research" },
            { href: "/glossary", label: "Glossary" },
          ].map((l) => (
            <Link key={l.href} href={l.href} className="hover:bg-muted focus-visible:outline-ring inline-flex min-h-11 items-center gap-1 rounded-md border px-3 focus-visible:outline-2 sm:min-h-9">
              {l.label}
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          ))}
        </nav>
      </div>
    </Panel>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function ArmsStory({ result, now }: { result: PaperOptionsResult; now: Date }) {
  const doc = result.status === "ok" ? result.doc : null;
  const unread = result.status === "error";
  const sent = doc ? armBooks(doc) : null;
  const books = sent ? sent.map((b) => insideWindow(b)) : null;
  const lab = labProgress(doc);
  const today = nyTime(now.toISOString()).day;
  const wires = wireStates(doc, now, (d) => paperStale(d, now));
  return (
    <div className="grid gap-8">
      <PaneBoundary name="The arms at a glance">
        <Hero />
      </PaneBoundary>
      {unread ? (
        <Empty title="Storage could not be read">The live figures below could not be read. The story itself is from the records; reload in a minute for the figures.</Empty>
      ) : null}
      <Section id="timeline" title="From the study to the close" intro="What happened when, and what comes next. The arms' dates are fixed by their records; the lab's steps move with its live progress.">
        <PaneBoundary name="Timeline">
          <Timeline today={today} lab={lab} />
        </PaneBoundary>
        <Panel id="lineage" title="The records behind them" icon={GitBranch} means="Which record registered, ran, ended, stopped and replaced the arms. Each id opens the record.">
          <PaneBoundary name="Record lineage">
            <Lineage />
          </PaneBoundary>
        </Panel>
      </Section>
      <Section
        id="how"
        title="Two kinds of arm"
        intro="Neither kind could change what the clone did. The clone holds one position at a time and shares its latches, so a second set of orders would have changed the control's own trades."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div className="bg-card grid gap-1.5 rounded-lg border p-4">
            <p className="flex items-center gap-2 font-medium">
              <Layers aria-hidden className="text-muted-foreground size-4" />
              Tag arms · 10 trials
            </p>
            <p className="text-muted-foreground text-sm">
              A flag written beside each of the clone&apos;s own decisions. A trial compares the clone&apos;s trades with the flag against those without it. No order, no trade of its own.
            </p>
          </div>
          <div className="bg-card grid gap-1.5 rounded-lg border p-4">
            <p className="flex items-center gap-2 font-medium">
              <FlaskConical aria-hidden className="text-muted-foreground size-4" />
              Shadow arms · 4 trials
            </p>
            <p className="text-muted-foreground text-sm">
              Simulated trades booked from the clone&apos;s own quotes and fills, in a file of their own. They never touch the order path.
            </p>
          </div>
        </div>
        <Panel id="pipeline" title="How the figures reach this page" icon={Sigma} means="Every step from the trading host to this page, with when each was last seen. The arms' path is switched off; the lab's path runs every session.">
          <PaneBoundary name="Pipeline">
            <Pipeline wires={wires} />
          </PaneBoundary>
        </Panel>
      </Section>
      <Section id="trials" title="The fourteen trials" intro="Each is its own trial, counted in family O. The words are category names of this page's own; each id opens its record.">
        <PaneBoundary name="The fourteen trials">
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {TRIALS.map((t) => (
              <TrialCard key={t.hyp} t={t} book={books?.find((b) => b.hyp === t.hyp) ?? (books ? { hyp: t.hyp, trades: [], meta: new Map(), uncounted: [], skipped: 0, truncated: 0 } : null)} sent={!!books?.some((b) => b.hyp === t.hyp && b.trades.length > 0)} />
            ))}
          </ul>
        </PaneBoundary>
        <Panel id="calendar" title="The window, session by session" icon={CalendarClock} means="The nine sessions the arms were booked in, each shadow arm's trades in each, the sessions each trial needed and never got, and the empty runway to the close.">
          <PaneBoundary name="Session calendar">
            <SessionHeatmap rows={sent ? heatmap(sent) : null} unread={unread} />
          </PaneBoundary>
        </Panel>
      </Section>
      <Section id="shadow" title="The shadow arms in detail" intro="Their simulated trades from 5 to 17 Nov 2026, the window the trials count. Nothing booked outside it is shown.">
        <PaneBoundary name="Shadow arms">
          <ShadowDetail books={books} unread={unread} />
        </PaneBoundary>
      </Section>
      <Section id="verdict" title="How a verdict would have been reached" intro="The registered test, run once by a script when a trial reaches its count. The page never runs it.">
        <Panel id="verdict-test" title="The session bootstrap" icon={Scale} means="Resampling by session, so one busy day cannot carry the result.">
          <div className="grid gap-5">
            <VerdictTest />
            <PaneBoundary name="Descriptive band">
              <DescriptiveBand books={books} />
            </PaneBoundary>
          </div>
        </Panel>
      </Section>
      <Section id="next" title="What replaced them" intro="The arms could never resolve. The research moved to measuring how options really trade before testing any new edge.">
        <PaneBoundary name="Where the research went">
          <LabCard doc={doc} lab={lab} unread={unread} />
        </PaneBoundary>
        <Panel id="gate" title="From recording to the first tables" icon={ListChecks} means={`Stage 1 records and counts sessions; stage 2 is the first four tables, at ${FIRST_READ} counted sessions. Each cell is one session of the lab's tape.`}>
          <PaneBoundary name="Gate tracker">
            <GateTracker track={unread ? null : gateTrack(doc)} unread={unread} />
          </PaneBoundary>
        </Panel>
      </Section>
      <p className="text-muted-foreground flex max-w-prose items-start gap-2 text-xs">
        <CalendarClock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Facts from <RecordLink id="DEC-0041" />, <RecordLink id="EXP-0030" />, <RecordLink id="DEC-0056" />, <RecordLink id="DEC-0057" />, <RecordLink id="DEC-0059" />, <RecordLink id="DEC-0060" />,{" "}
          <RecordLink id="DEC-0067" /> and <RecordLink id="EXP-0052" />. Figures from the paper options history the trading host sends{doc ? ` (built ${dayWords(nyTime(doc.as_of).day)}, New York)` : ""}. Paper and simulated only:
          nothing here can trade.
        </span>
      </p>
    </div>
  );
}
