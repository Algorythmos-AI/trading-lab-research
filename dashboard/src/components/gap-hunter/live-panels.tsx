// Gap Hunter's live panels (DEC-0078): what it is doing now, its day so far, its position, its rules this minute,
// its orders, its safety rules and its closed trades. Server-rendered from lib/gap-hunter-now.ts, which reads the
// newer of the snapshot's block and the robot's own live document. The root layout refreshes the page every minute.
//
// Symbols and prices are PRIVATE and shown behind the owner's login, inside the page's paper frame. Rules are named by
// code; no setup name, no rule text and no journal free text reaches this page.
import { Activity, BookOpen, ClipboardList, Crosshair, History, Layers, ListChecks, ShieldCheck } from "lucide-react";
import { CumulativeChart } from "@/components/charts/cumulative-chart";
import { TradeBars } from "@/components/charts/trade-bars";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { StepRail } from "@/components/step-rail";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { newYork, shortDate, sydney } from "@/lib/format";
import { rCurve } from "@/lib/r-curve";
import {
  dayRail,
  eventWords,
  freshnessOf,
  hero,
  ladder,
  orders,
  pickWhy,
  reasonWords,
  results,
  ruleWords,
  stateWords,
  stopRuleProgress,
  whyWords,
  type Clock,
  type FreshState,
  type Live,
  type Source,
  type Tone,
} from "@/lib/gap-hunter-now";
import { cn } from "@/lib/utils";

const TONE_TEXT: Record<Tone, string> = { good: "text-good", warn: "text-warn", bad: "text-bad", info: "text-info", neutral: "text-muted-foreground" };
const HERO_RING: Record<Tone, string> = { good: "border-good/40", warn: "border-warn/50", bad: "border-bad/50", info: "border-info/40", neutral: "border-border" };
const FRESH: Record<FreshState, { tone: Tone; words: (age: string) => string }> = {
  fresh: { tone: "good", words: (a) => `Live · ${a}` },
  late: { tone: "warn", words: (a) => `Late · ${a}` },
  stopped: { tone: "bad", words: (a) => `Not updating · ${a}` },
  asleep: { tone: "neutral", words: (a) => `Market closed · data ${a}` },
  unknown: { tone: "neutral", words: () => "No data yet" },
};

const timeNy = (iso: string) => newYork(iso, false);
const price = (v: number | null) => (v === null ? "—" : v.toFixed(2));
const rText = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`);
const rTone = (v: number | null): Tone => (v === null ? "neutral" : v > 0 ? "good" : v < 0 ? "bad" : "neutral");
const ago = (min: number | null) => (min === null ? "" : min < 1 ? "under a minute old" : min < 90 ? `${Math.round(min)} min old` : `${Math.round(min / 60)} h old`);

// ---------------------------------------------------------------- now

export function NowHero({ live, src, clock, now }: { live: Live | null; src: Source; clock: Clock; now: Date }) {
  const h = hero(live, clock);
  const f = freshnessOf(src, now);
  const fresh = FRESH[f.state];
  return (
    <section aria-label="What Gap Hunter is doing now" data-gap-now={h.word} className={cn("bg-card grid gap-3 rounded-xl border-2 px-5 py-4 shadow-sm", HERO_RING[h.tone])}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="warn">Paper money only</StatusBadge>
        <StatusBadge tone={fresh.tone}>{fresh.words(ago(f.ageMin))}</StatusBadge>
        <span className="text-muted-foreground ml-auto text-xs" data-gap-source={src.from}>
          {src.asOf ? `Built ${newYork(src.asOf)} New York · ${sydney(src.asOf, false)} Sydney` : "Nothing received"}
          {src.from === "live" ? " · every minute" : src.from === "snapshot" ? " · every 5 minutes" : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className={cn("text-2xl font-semibold tracking-tight", TONE_TEXT[h.tone])}>{h.word}</h2>
        {h.symbol ? <span className="font-mono text-2xl font-semibold">{h.symbol}</span> : null}
      </div>
      <p className="max-w-prose text-sm">{h.line}</p>
      {live?.heartbeat?.lastRow ? (
        <p className="text-muted-foreground text-xs">
          Last thing it wrote: {newYork(live.heartbeat.lastRow)} New York{live.heartbeat.rowsToday !== null ? ` · ${live.heartbeat.rowsToday} rows that day` : ""}
          {live.heartbeat.armedAt ? ` · armed ${timeNy(live.heartbeat.armedAt)}` : ""}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- the day

export function DayPanel({ live, clock }: { live: Live | null; clock: Clock }) {
  const session = live?.heartbeat?.session ?? null;
  const today = session !== null && session === clock.today;
  return (
    <Panel
      title="Its day"
      icon={ListChecks}
      means="The session's steps in order, each with its New York time: armed before the open, the morning pick, an entry order, its fill, managing the trade (part sold at the first target, the stop moved), the trade closed, and the session's end."
      action={session ? <StatusBadge tone={today ? "info" : "neutral"}>{today ? "Today" : `Last session ${shortDate(session)}`}</StatusBadge> : undefined}
    >
      {live ? <StepRail steps={dayRail(live, timeNy)} label="Gap Hunter's session, step by step" /> : <Empty icon={ListChecks} title="No session has been sent yet" />}
    </Panel>
  );
}

// ---------------------------------------------------------------- the position

export function PositionPanel({ live }: { live: Live | null }) {
  const p = live?.position ?? null;
  const rungs = ladder(p);
  return (
    <Panel
      title="Position"
      icon={Crosshair}
      means="The trade it holds, or the entry order it has resting, from the robot's own plan file. Prices top to bottom, each with its R: the trade's result at that price, in units of what it risked (entry less the first stop). The broker is the final word; this is the robot's record."
      action={p ? <StatusBadge tone={p.state === "entry_working" ? "info" : "good"}>{stateWords(p.state)}</StatusBadge> : <StatusBadge tone="neutral">Flat</StatusBadge>}
    >
      {!p ? (
        <Empty icon={Crosshair} title="No position and no resting order">
          When it holds a trade, its stop, entry and target show here as a ladder.
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ol aria-label="Price ladder, highest first" className="grid gap-1.5" data-gap-ladder="">
            {rungs.map((r) => (
              <li key={r.key} className="bg-muted/40 flex items-center gap-3 rounded-lg border px-3 py-2">
                <span className={cn("size-2.5 shrink-0 rounded-full", r.tone === "good" ? "bg-good-fill" : r.tone === "bad" ? "bg-bad-fill" : r.tone === "info" ? "bg-info-fill" : "bg-neutral-fill")} aria-hidden />
                <span className="text-sm">{r.label}</span>
                <span className="ml-auto font-mono text-sm tabular-nums">{price(r.price)}</span>
                <span className={cn("w-16 text-right font-mono text-xs tabular-nums", TONE_TEXT[rTone(r.r)])}>{rText(r.r)}</span>
              </li>
            ))}
          </ol>
          <KeyValues
            className="sm:grid-cols-2"
            items={[
              { label: "Symbol", value: <span className="font-mono">{p.symbol ?? "—"}</span> },
              { label: "Rule", value: <span className="font-mono">{p.code ?? "—"}</span> },
              { label: "Shares held", value: p.shares ?? "—" },
              { label: "Sold at the first target", value: p.soldAtTarget ?? 0 },
              { label: "Entry order at", value: price(p.trigger) },
              { label: "How it came", value: p.origin === "entry" ? "Its own entry" : p.origin === "orphan" ? "Found and taken over" : (p.origin ?? "—") },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- the pick and its rules

export function PickPanel({ live }: { live: Live | null }) {
  const pick = live?.pick ?? null;
  const rules = live?.rules ?? [];
  return (
    <Panel
      title="Today's name and its rules"
      icon={Layers}
      means="The morning's pick, the tier-2 names behind it in rank order, and where each of its four entry rules (e1 to e4) stands this minute. A rule with an order ready rests a buy order at its trigger; the others are waiting or done for the day."
      action={pick?.symbol ? <span className="font-mono text-lg font-semibold">{pick.symbol}</span> : undefined}
    >
      {!pick ? (
        <Empty icon={Layers} title="No pick has been sent yet" />
      ) : (
        <div className="grid gap-4">
          {pick.symbol ? (
            <p className="text-sm">
              Picked <span className="font-mono font-semibold">{pick.symbol}</span>
              {pick.rank !== null ? `, rank ${pick.rank}` : ""}.
              {pick.tier2.length > 0 ? (
                <>
                  {" "}
                  Tier 2 in rank order: <span className="font-mono">{pick.tier2.join(" · ")}</span>
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-sm">No name was picked: {pickWhy(pick.why)}.</p>
          )}
          {rules.length > 0 ? (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="Entry rules this minute">
              {rules.map((r) => {
                const w = ruleWords(r.why);
                return (
                  <li key={r.rule} data-rule={r.rule} data-rule-why={r.why ?? ""} className={cn("grid gap-1 rounded-lg border px-3 py-2.5", r.why === "ok" && "border-info/50 bg-info-soft")}>
                    <span className="font-mono text-sm font-semibold">{r.rule}</span>
                    <span className={cn("text-sm", TONE_TEXT[w.tone])}>{w.words}</span>
                    {r.trigger !== null || r.stop !== null ? (
                      <span className="text-muted-foreground font-mono text-xs tabular-nums">
                        buy {price(r.trigger)} · stop {price(r.stop)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : pick.symbol ? (
            <p className="text-muted-foreground text-xs">No rule has reported this session yet.</p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- what happened, in order

export function TimelinePanel({ live }: { live: Live | null }) {
  const rows = [...(live?.timeline ?? [])].reverse();
  return (
    <Panel title="What it did" icon={History} means="Every step the robot wrote in its journal for its last session, newest first, in New York time with Sydney beside it. Codes only: e1 to e4 name the rules.">
      {rows.length === 0 ? (
        <Empty icon={History} title="Nothing written yet this session" />
      ) : (
        <ol className="divide-border grid divide-y" aria-label="Gap Hunter's journal, newest first">
          {rows.map((r, i) => {
            const w = eventWords(r);
            const why = whyWords(r.why);
            return (
              <li key={`${r.t}-${i}`} data-event={r.event} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 first:pt-0 last:pb-0">
                <span className="font-mono text-xs tabular-nums">{timeNy(r.t)}</span>
                <span className={cn("text-sm font-medium", TONE_TEXT[w.tone])}>{w.words}</span>
                {r.symbol ? <span className="font-mono text-xs">{r.symbol}</span> : null}
                {r.code ? <span className="text-muted-foreground font-mono text-xs">{r.code}</span> : null}
                {why ? <span className="text-muted-foreground text-xs">{why}</span> : null}
                {r.r !== null ? <span className={cn("font-mono text-xs", TONE_TEXT[rTone(r.r)])}>{rText(r.r)}</span> : null}
                <span className="text-muted-foreground ml-auto text-xs">{sydney(r.t, false)} Sydney</span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

export function OrdersPanel({ live }: { live: Live | null }) {
  const rows = orders(live);
  return (
    <Panel title="Orders" icon={ClipboardList} means="Its order activity in the session: entries placed, filled, cancelled or not placed, part sold at the first target, stops moved, signals its safety checks blocked, and the trade's close.">
      {rows.length === 0 ? (
        <Empty icon={ClipboardList} title="No order this session" />
      ) : (
        <Table label="Gap Hunter orders this session">
          <TableHeader>
            <TableRow>
              <TableHead>New York</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${r.t}-${i}`}>
                <TableCell className="font-mono text-xs">{timeNy(r.t)}</TableCell>
                <TableCell>
                  <StatusBadge tone={r.tone}>{r.what}</StatusBadge>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.symbol ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs">{r.code ?? "—"}</TableCell>
                <TableCell className="text-xs">{r.r !== null ? rText(r.r) : (r.why ?? "—")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- safety

function Meter({ label, share, words, tone }: { label: string; share: number | null; words: string; tone: Tone }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{words}</span>
      </div>
      <div className="bg-muted h-2 overflow-hidden rounded-full" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share === null ? undefined : Math.round(share * 100)}>
        <div className={cn("h-full rounded-full", tone === "bad" ? "bg-bad-fill" : tone === "warn" ? "bg-warn-fill" : "bg-info-fill")} style={{ width: `${Math.round((share ?? 0) * 100)}%` }} />
      </div>
    </div>
  );
}

export function SafetyPanel({ live }: { live: Live | null }) {
  const sr = live?.stopRule ?? null;
  const prog = stopRuleProgress(sr);
  const lossTone: Tone = prog.loss === null ? "neutral" : prog.loss >= 0.75 ? "bad" : prog.loss >= 0.5 ? "warn" : "info";
  const items: { label: string; ok: boolean | null; on: string; off: string }[] = [
    { label: "Kill switch", ok: live?.kill === null || live?.kill === undefined ? null : !live.kill, on: "Off", off: "On: no new entries" },
    { label: "Loss limits", ok: live?.latched === null || live?.latched === undefined ? null : !live.latched, on: "Clear", off: "Latched: no new entries" },
    { label: "Execution safety stops (X1 to X5)", ok: live ? live.xLatched.length === 0 : null, on: "None latched", off: `Latched: ${live?.xLatched.join(", ")}` },
    { label: "A rule switched on", ok: live?.enabled ?? null, on: "Yes", off: "No: it places no order" },
  ];
  return (
    <Panel
      title="Safety"
      icon={ShieldCheck}
      means={`Every brake on the robot, green when it does not stop new entries. The stop rule${sr?.decision ? ` (${sr.decision})` : ""} ends the trial early at its loss limit, and reviews it once enough trades are booked. Exits are always managed, whatever is latched.`}
    >
      {!live ? (
        <Empty icon={ShieldCheck} title="Not sent yet" />
      ) : (
        <div className="grid gap-4">
          <ul className="grid gap-2 sm:grid-cols-2">
            {items.map((x) => (
              <li key={x.label} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <StatusBadge tone={x.ok === null ? "neutral" : x.ok ? "good" : "bad"}>{x.ok === null ? "Not sent" : x.ok ? x.on : x.off}</StatusBadge>
                <span className="text-sm">{x.label}</span>
              </li>
            ))}
          </ul>
          {sr ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Meter label={`Trades toward the review at ${sr.reviewAt ?? "?"}`} share={prog.trades} words={`${sr.trades ?? "?"} of ${sr.reviewAt ?? "?"}`} tone="info" />
              <Meter label={`Loss toward its limit of ${rText(sr.maxLossR)}`} share={prog.loss} words={`${rText(sr.sumR)} of ${rText(sr.maxLossR)}`} tone={lossTone} />
              {sr.stopDate ? <p className="text-muted-foreground text-xs sm:col-span-2">The trial runs to {shortDate(sr.stopDate)} at the latest.</p> : null}
            </div>
          ) : null}
          {live.rotation ? (
            <p className="text-muted-foreground text-xs">
              {live.rotation.live ? "Rotation (HYP-0072, trading)" : "Rotation shadow (counts only, not traded)"}: {live.rotation.names ?? "?"} names watched, {live.rotation.changes ?? "?"} changes{live.rotation.done ? `, ended: ${live.rotation.done.replace(/_/g, " ")}` : ""}.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- closed trades

export function ClosedPanel({ live }: { live: Live | null }) {
  const rows = [...(live?.closed ?? [])].reverse();
  const t = results(live);
  // The booked trades, oldest first, as a running R curve: SAFE figures only (day, rule code, R), never a symbol.
  const curve = rCurve(
    (live?.closed ?? []).filter((x) => x.booked !== false).map((x) => ({ day: x.day, r: x.r, code: x.code })),
    (d) => (d ? shortDate(d) : "—"),
  );
  return (
    <Panel
      title="Closed trades"
      icon={Activity}
      means="Each trade it closed, newest first, with its paper result in R and the same trade after two cost haircuts (H1 and H2, DEC-0074): what it would have made with more realistic fills. A trade that is not booked does not count toward the stop rule."
      action={t.trades > 0 ? <StatusBadge tone={rTone(t.sumR)}>{`${t.trades} booked · ${rText(t.sumR)}`}</StatusBadge> : undefined}
    >
      {rows.length === 0 ? (
        <Empty icon={Activity} title="No closed trade yet" />
      ) : (
        <div className="grid gap-3">
          <KeyValues
            items={[
              { label: "Booked trades", value: t.trades },
              { label: "Winners", value: `${t.wins} of ${t.trades}` },
              { label: "Paper R", value: <span className={TONE_TEXT[rTone(t.sumR)]}>{rText(t.sumR)}</span> },
              { label: "After haircut H1", value: <span className={TONE_TEXT[rTone(t.sumH1)]}>{rText(t.sumH1)}</span> },
              { label: "After haircut H2", value: <span className={TONE_TEXT[rTone(t.sumH2)]}>{rText(t.sumH2)}</span> },
            ]}
          />
          {curve.points.length >= 2 ? (
            <div className="grid gap-4 lg:grid-cols-2" data-testid="gap-r-charts">
              <figure className="grid gap-2">
                <figcaption className="text-muted-foreground text-xs">
                  Running total in R, trade by trade; the shade is how far it stands below its earlier high (deepest {rText(curve.maxDd)}).
                </figcaption>
                <CumulativeChart compact points={curve.points.map((p) => ({ i: p.i, day: p.day, cum: p.cum, dd: p.dd }))} />
              </figure>
              <figure className="grid gap-2">
                <figcaption className="text-muted-foreground text-xs">
                  Each booked trade&apos;s result in R, oldest first: {curve.wins} up, {curve.losses} down.
                </figcaption>
                <TradeBars
                  label="Gap Hunter: result of each booked trade in R, oldest first"
                  whenLabel="Day"
                  trades={curve.points.map((p) => ({ i: p.i, r: p.r, what: `Trade ${p.i}${p.code ? ` · rule ${p.code}` : ""}`, when: p.day }))}
                />
              </figure>
            </div>
          ) : null}
          <Table label="Gap Hunter closed trades">
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>How it ended</TableHead>
                <TableHead className="text-right">R</TableHead>
                <TableHead className="text-right">H1</TableHead>
                <TableHead className="text-right">H2</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.day}-${r.symbol}-${i}`} data-booked={String(r.booked)}>
                  <TableCell className="text-xs">{shortDate(r.day)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.symbol ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{r.code ?? "—"}</TableCell>
                  <TableCell className="text-xs">
                    {reasonWords(r.reason)}
                    {r.booked === false ? " · not booked" : ""}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono text-xs", TONE_TEXT[rTone(r.r)])}>{rText(r.r)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{rText(r.h1)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{rText(r.h2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- how it works

export function HowItWorks() {
  return (
    <details className="bg-card group rounded-xl border px-5 py-3 shadow-sm">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <BookOpen aria-hidden className="size-4" /> How Gap Hunter works
      </summary>
      <ol className="mt-3 grid max-w-prose list-decimal gap-2 pl-5 text-sm">
        <li>Before the open it reads the morning pool: the stocks gapping up, from a scan of the whole market.</li>
        <li>It filters them, ranks what passes, and picks one name for the day. The tier-2 names are the ranked runners-up.</li>
        <li>From the open, four entry rules (e1 to e4) each check the name every minute. A rule that is ready rests a buy order with its own stop.</li>
        <li>Once filled, it sells part at the first target and moves the stop to break-even, and it is flat by the close.</li>
        <li>
          Its brakes: a kill switch, daily loss limits, execution safety stops, and a stop rule that ends the trial at its loss limit. A brake stops new entries; exits are
          always managed.
        </li>
        <li>All of it is paper money, in its own Alpaca paper account. This page only reads; nothing here can place or cancel an order.</li>
      </ol>
    </details>
  );
}
