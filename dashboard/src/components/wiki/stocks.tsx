// The stocks desk's Engineering wiki: what feeds each page of the Stocks site, what runs when, and how the paper
// robot keeps its orders safe, drawn as pictures whose dots come from the snapshot and the stored editions.
// Software only: no spec text, setup names or decision prose (the repo is restricted); gates and decisions appear
// by id, name and status.
import { StatusBadge } from "@/components/status";
import { describeAge, LATE_MIN } from "@/lib/freshness";
import { dayIn, NEW_YORK, num, shortDate, shortSha, sydney, SYDNEY, txt } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { editionState } from "@/lib/options";
import { radarStale } from "@/lib/radar";
import { GAP_HUNTER } from "@/lib/robots";
import type { JournalResult, OptionsLiveResult, OptionsResult, RadarResult, SnapshotResult } from "@/lib/snapshot";
import { entries, list, type Snapshot } from "@/lib/types";
import {
  ciLanes,
  currentGate,
  daysSince,
  everyFresh,
  FEED_TONE,
  gateTone,
  jobDot,
  jobsHealthy,
  journalFresh,
  nyMinutes,
  sydneyAheadOfNy,
  TONE_VAR,
  utcToNy,
  type FeedState,
} from "@/lib/wiki";
import { Diagram, Dot, Edge, EdgeLabel, Figure, Node, T, ToneDot, WikiSection, Why, Zone, type TocGroup } from "./kit";

export const STOCKS_TOC: TocGroup = {
  title: "Stocks desk",
  items: [
    { id: "glance", label: "At a glance" },
    { id: "architecture", label: "Where the data comes from" },
    { id: "feeds", label: "Is the data fresh?" },
    { id: "day", label: "A trading day" },
    { id: "orders", label: "The paper robot's safety" },
    { id: "gates", label: "Research gates" },
    { id: "runbooks", label: "Runbooks and decisions" },
  ],
};

// ---- the feeds: what each page reads, who writes it and when ------------------------------------------------------

/** The scheduled tasks' clock times in UTC (they run in the cloud, on UTC schedules), as minutes after midnight. */
const RADAR_UTC = 10 * 60 + 30;
const RADAR_SEND_UTC = 11 * 60 + 12;
const WEBULL_BACKSTOP_UTC = 21 * 60 + 38;
const LEVELS_UTC = 21 * 60 + 52;

const hhmm = (m: number) => {
  const d = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
};

export type FeedKey = "snapshot" | "positions" | "levels" | "radar" | "journal";

export interface Feed {
  key: FeedKey;
  /** Its name in a sentence: "the radar". */
  short: string;
  /** The page it lands on, and where that page is. */
  page: string;
  href: string;
  /** What it carries, in a few words. */
  what: string;
  /** Who writes it: the trading host or a scheduled task in the cloud. */
  by: string;
  where: "host" | "task";
  /** When it is written, in New York time. */
  when: string;
  state: FeedState;
  asOf: string | null;
  /** A short extra fact: the session a levels edition is for, the date of a radar. */
  note?: string;
}

export interface FeedInputs {
  snapshot: SnapshotResult;
  positions: OptionsLiveResult;
  levels: OptionsResult;
  radar: RadarResult;
  journal: JournalResult;
}

/** The radar is on time until a session opens on an older edition, and never more than four days old (a weekend and a holiday). */
function radarOnTime(editionDate: string, now: Date): boolean {
  const today = dayIn(now.toISOString(), NEW_YORK);
  const gap = today ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${editionDate}T00:00:00Z`)) / 86_400_000 : NaN;
  return !radarStale(editionDate, now) && Number.isFinite(gap) && gap <= 4;
}

const stateOf = (status: "ok" | "missing" | "error", fresh: boolean): FeedState =>
  status === "missing" ? "missing" : status === "error" ? "error" : fresh ? "fresh" : "late";

/** Every feed of the Stocks site, with whether it arrived when it should have. */
export function stocksFeeds(i: FeedInputs, now: Date): Feed[] {
  const snapAsOf = i.snapshot.status === "ok" ? (i.snapshot.snapshot.as_of ?? null) : null;
  const posAsOf = i.positions.status === "ok" ? (i.positions.doc.as_of ?? null) : null;
  const lev = i.levels.status === "ok" ? i.levels.edition : null;
  const rad = i.radar.status === "ok" ? i.radar.edition : null;
  const jAsOf = i.journal.status === "ok" ? (i.journal.doc.as_of ?? null) : null;
  return [
    {
      key: "snapshot",
      short: "snapshot",
      page: "Overview, Today, Operations",
      href: "/operations",
      what: "the paper robot, scans, jobs, host health",
      by: "host · publisher",
      where: "host",
      when: "every 5 min in the session, 15 otherwise",
      state: stateOf(i.snapshot.status, everyFresh(snapAsOf, now, LATE_MIN)),
      asOf: snapAsOf,
    },
    {
      key: "positions",
      short: "option positions",
      page: "Options",
      href: "/options",
      what: "your paper option positions",
      by: "host · options job",
      where: "host",
      when: "every 5 min in the session, 15 otherwise",
      state: stateOf(i.positions.status, everyFresh(posAsOf, now, LATE_MIN)),
      asOf: posAsOf,
    },
    {
      key: "levels",
      short: "levels",
      page: "Options",
      href: "/options",
      what: "levels, zones and the top 4 focus",
      by: "scheduled task · after the close",
      where: "task",
      when: `${hhmm(utcToNy(LEVELS_UTC, now))} after each session`,
      state: stateOf(i.levels.status, lev ? editionState(lev.session, now) !== "stale" : false),
      asOf: lev?.as_of ?? null,
      note: lev ? `for ${shortDate(lev.session)}` : undefined,
    },
    {
      key: "radar",
      short: "radar",
      page: "Radar",
      href: "/radar",
      what: "pre-market research and watch lists",
      by: "scheduled tasks · build, then send",
      where: "task",
      when: `${hhmm(utcToNy(RADAR_UTC, now))} build, ${hhmm(utcToNy(RADAR_SEND_UTC, now))} send`,
      state: stateOf(i.radar.status, rad ? radarOnTime(rad.edition_date, now) : false),
      asOf: rad?.as_of ?? null,
      note: rad ? `edition of ${shortDate(rad.edition_date)}` : undefined,
    },
    {
      key: "journal",
      short: "trades",
      page: "Trades",
      href: "/trades",
      what: "your Webull trades, read only",
      by: "scheduled tasks · live sync, backstop",
      where: "task",
      when: `every 2 min 09:24–16:20, backstop ${hhmm(utcToNy(WEBULL_BACKSTOP_UTC, now))}`,
      state: stateOf(i.journal.status, journalFresh(jAsOf, now)),
      asOf: jAsOf,
    },
  ];
}

const FEED_WORD: Record<FeedState, string> = { fresh: "on time", late: "late", missing: "not published yet", error: "unreadable" };

function feedWord(f: Feed, now: Date): string {
  const age = f.asOf ? Date.parse(f.asOf) : NaN;
  const ago = Number.isFinite(age) ? describeAge((now.getTime() - age) / 60_000) : null;
  return f.state === "fresh" || f.state === "late" ? `${FEED_WORD[f.state]}, arrived ${ago ?? "at an unknown time"}` : FEED_WORD[f.state];
}

const feedDot = (f: Feed | undefined, now: Date) =>
  f ? { tone: FEED_TONE[f.state], title: `${f.page} · ${f.what}: ${feedWord(f, now)}` } : undefined;

// ---- at a glance ----------------------------------------------------------------------------------------------------

const TILE_TEXT: Record<Tone, string> = { good: "text-good", warn: "text-warn", bad: "text-bad", info: "text-info", neutral: "text-foreground" };

function Tile({ label, value, sub, tone, className = "" }: { label: string; value: string; sub?: string; tone: Tone; className?: string }) {
  return (
    <li className={`bg-card grid min-w-0 gap-0.5 rounded-lg border px-3.5 py-3 ${className}`}>
      <span className="text-muted-foreground text-[0.6875rem] tracking-wider uppercase max-sm:text-xs">{label}</span>
      <span className={`text-base font-semibold ${TILE_TEXT[tone]}`}>{value}</span>
      {sub ? <span className="text-muted-foreground text-xs">{sub}</span> : null}
    </li>
  );
}

/** How the host's code stands against main: the deploy the owner may need to run. */
export function hostCode(s: Snapshot | null, now: Date): { sha: string; sub: string; tone: Tone; stuck: boolean } {
  const dep = s?.ops?.deployed;
  const behind = dep?.behind;
  const days = daysSince(dep?.committed, now);
  const day = dayIn(dep?.committed, SYDNEY);
  const from = day ? `from ${shortDate(day)}` : "date not reported";
  if (typeof behind !== "number") return { sha: shortSha(dep?.head), sub: `${from} · compare with main unavailable`, tone: "neutral", stuck: false };
  if (behind === 0) return { sha: shortSha(dep?.head), sub: `${from} · level with main`, tone: "good", stuck: false };
  // Main moves several times a day; a gap only matters once the host's code is more than a day old.
  const stuck = days !== null && days >= 1;
  return {
    sha: shortSha(dep?.head),
    sub: `${from} · main is ${num(behind)} commit${behind === 1 ? "" : "s"} ahead`,
    tone: stuck ? "warn" : "neutral",
    stuck,
  };
}

export function GlanceSection({ s, feeds, now, siteSha }: { s: Snapshot | null; feeds: Feed[]; now: Date; siteSha: string | null }) {
  const last = entries(s?.jobs?.last);
  const jobs = jobsHealthy(last.map(([, r]) => r));
  const failed = last.filter(([, r]) => jobDot(r).tone !== "good").map(([k]) => k);
  const latched = s?.ops?.paper?.virtual?.latched === true;
  const kill = s?.kill?.on === true;
  const lanes = ciLanes(s?.platform?.runs);
  const ci = lanes.find((l) => l.workflow === "ci")?.latestMain;
  const fresh = feeds.filter((f) => f.state === "fresh").length;
  const notFresh = feeds.filter((f) => f.state !== "fresh");
  const feedTone: Tone = notFresh.some((f) => f.state === "error") ? "bad" : notFresh.length ? "warn" : "good";
  const host = hostCode(s, now);
  return (
    <WikiSection
      id="glance"
      eyebrow="Stocks desk"
      title="At a glance"
      lede="Is everything that feeds this site arriving, and does anything need you? Read from the stored data on every visit."
    >
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3" aria-label="The stocks desk at a glance">
        <Tile
          label="Data feeds"
          value={`${fresh} of ${feeds.length} on time`}
          sub={notFresh.length ? notFresh.map((f) => `${f.short}: ${FEED_WORD[f.state]}`).join(", ") : "every page's data arrived when it should"}
          tone={feedTone}
        />
        <Tile
          label="Host jobs"
          value={jobs.total ? `${jobs.ok} of ${jobs.total} ok` : "—"}
          sub={failed.length ? `needs a look: ${failed.join(", ")}` : "every job's last run ended well"}
          tone={jobs.tone}
        />
        <Tile label="Code on the host" value={host.sha} sub={host.sub} tone={host.tone} />
        <Tile
          label="Code on this site"
          value={siteSha ? siteSha.slice(0, 7) : "—"}
          sub="every merge to main deploys the site within minutes"
          tone="neutral"
        />
        <Tile
          label="Paper robot"
          value={latched ? "Latched" : kill ? "Kill switch on" : "Entries allowed"}
          sub={latched || kill ? "no new entries; exits are still managed" : "kill switch off, loss latch clear"}
          tone={latched ? "bad" : kill ? "warn" : "good"}
        />
        <Tile label="Checks on main" value={ci ? ci.conclusion : "—"} sub={ci ? "newest ci run" : "no ci run in the snapshot"} tone={ci ? ci.tone : "neutral"} />
      </ul>
      {host.stuck ? (
        <aside className="border-warn-fill bg-warn-soft max-w-prose rounded-r-md border-l-2 px-3.5 py-2.5 text-sm" aria-label="Needs you">
          <b className="text-warn font-semibold">Needs you: the host is running old code.</b> Its jobs still run commit {host.sha}{" "}
          ({host.sub.split(" · ")[0]}). The site already has everything newer, but changes to the host&apos;s own jobs wait for a deploy, and a
          release that adds or changes the host&apos;s services always waits for you. Run{" "}
          <code className="font-mono text-xs">sudo -u wt /usr/local/bin/wt-deploy deploy</code> after 18:00 New York, then{" "}
          <code className="font-mono text-xs">sudo wt-install-units</code> (docs/runbooks/gcp-host.md).
        </aside>
      ) : null}
    </WikiSection>
  );
}

// ---- where the data comes from --------------------------------------------------------------------------------------

export function ArchitectureSection({ s, feeds, now }: { s: Snapshot | null; feeds: Feed[]; now: Date }) {
  const id = "dg-arch";
  const last = new Map(entries(s?.jobs?.last));
  const job = (key: string, name: string) => {
    const d = jobDot(last.get(key));
    return { tone: d.tone, pulse: d.pulse, title: `${name}: last run ${d.word}` };
  };
  const f = (k: FeedKey) => feeds.find((x) => x.key === k);
  const dot = (k: FeedKey) => feedDot(f(k), now);
  const label = `Where the Stocks site's data comes from. Left of a red line everything is paper or read only. Alpaca's paper accounts send bars to the routine, Gap Hunter and forward jobs, and take Gap Hunter's paper orders. The forward job's ledger feeds the weekly scorecard. Those four jobs write state files that the publisher collects into the snapshot. Alpaca paper account B sends your paper option positions to the options job. A job runner on the trading host starts every job and sends alerts and dead-man pings to your phone. IBKR sends last prices to the pre-open focus, bars and implied vol to the after-close levels, and lists and prices to the radar build. The levels run picks the focus; the radar build leaves its edition in an outbox for the radar send. Webull Australia sends your real trades, read only, to the Webull sync and its backstop. Every one of those feeds reaches this site through its signed ingest: the snapshot to Overview, Today and Operations; positions, levels and focus to Options; the radar to Radar; the journal to Trades. Live prices come to Options straight from Alpaca's IEX quotes through the site, not through the ingest. The site's watchdog checks the snapshot's age and pages your phone when it is late. Host jobs: ${[
    ["routine", "routine"],
    [GAP_HUNTER.job, GAP_HUNTER.name],
    ["forward", "forward"],
    ["weekly", "weekly"],
    ["dashboard", "publisher"],
  ]
    .map(([k, n]) => `${n} (last run ${jobDot(last.get(k!)).word})`)
    .join(", ")}. Feeds: ${feeds
    .map((x) => `${x.page} · ${x.what}: ${feedWord(x, now)}`)
    .join("; ")}.`;
  return (
    <WikiSection
      id="architecture"
      eyebrow="Stocks desk"
      title="Where the data comes from"
      lede="Outside sources on the left, the two places that do the work in the middle, this site on the right. Every arrow is a real read or write; each page reads only what its own feed sends."
    >
      <Figure
        minWidth={820}
        caption={
          <>
            <b className="text-foreground font-medium">The Stocks site, end to end.</b> A dot on a job is its last run; a dot on a page is
            whether its data arrived on time. Hover a dot for its words. A word on an arrow is what travels on it; a moving
            arrow is a data path. Left of the red line everything is paper or read only: nothing here can place a real order.
          </>
        }
      >
        <Diagram id={id} w={1000} h={712} label={label}>
          {/* sources */}
          <T x={20} y={30} caps>
            Sources
          </T>
          <T x={20} y={52} muted>
            paper or read only:
          </T>
          <T x={20} y={67} muted>
            no real orders from here
          </T>
          <Node x={20} y={86} w={180} h={134} title="Alpaca paper accounts" sub={["bars for the jobs,", "paper orders"]} tone="info" dot={job(GAP_HUNTER.job, GAP_HUNTER.name)} />
          <Node x={20} y={286} w={180} h={46} title="Alpaca paper B" sub="your paper options, read" tone="info" dot={dot("positions")} />
          <Node x={20} y={404} w={180} h={108} title="IBKR" sub="prices, read only" tone="info" />
          <Node x={20} y={532} w={180} h={86} title="Webull Australia" sub="your real trades, read only" tone="info" dot={dot("journal")} />
          <Node x={20} y={656} w={180} h={44} title="Alpaca market data" sub="IEX quotes, read only" tone="info" />
          <line x1={214} y1={20} x2={214} y2={704} style={{ stroke: "var(--bad-fill)" }} strokeWidth={2} strokeDasharray="8 5" />

          {/* the zones first, so no zone covers an arrow */}
          <Zone x={232} y={14} w={440} h={330} label="Trading host · cloud VM" />
          <Zone x={232} y={358} w={440} h={288} label="Scheduled tasks · Claude, in the cloud" />
          <Node x={760} y={14} w={224} h={42} title="your phone" sub="ntfy alerts, healthchecks" tone="warn" />

          {/* the site */}
          <Zone x={690} y={70} w={302} h={580} label="This site · Vercel" />
          <rect x={704} y={110} width={34} height={510} rx={6} style={{ fill: `color-mix(in srgb, ${TONE_VAR.info} 11%, var(--card))`, stroke: TONE_VAR.info }} />
          <text x={725} y={365} fontSize={12.5} textAnchor="middle" transform="rotate(-90 725 365)" style={{ fill: "var(--foreground)" }}>
            signed ingest · every feed checked against its schema
          </text>
          <Node x={754} y={150} w={136} h={54} title="Overview · Today" sub={["Operations,", "Research, Risk"]} dot={dot("snapshot")} />
          <Node x={754} y={290} w={136} h={150} title="Options" sub={["paper positions,", "levels and focus"]} dot={dot("levels")} />
          <Node x={754} y={472} w={136} h={40} title="Radar" sub="pre-market edition" dot={dot("radar")} />
          <Node x={754} y={532} w={136} h={86} title="Trades" sub="your Webull journal" dot={dot("journal")} />
          <Node x={904} y={150} w={80} h={54} title="watchdog" sub="every 10 min" />
          <Node x={904} y={340} w={80} h={50} title="live prices" sub={["Alpaca IEX,", "every 2 s"]} />

          {/* the trading host */}
          <Node x={246} y={44} w={412} h={28} title="systemd timers → job runner · lock, preflight, deadline" />
          {[
            ["routine", "routine", "Mon–Fri 07:30", 86],
            [GAP_HUNTER.job, GAP_HUNTER.name, "08:30 to the close", 134],
            ["forward", "forward", "12:40, after the close", 182],
            ["weekly", "weekly", "Fri 20:00", 238],
          ].map(([key, name, when, y]) => (
            <Node key={key} x={246} y={y as number} w={150} h={38} title={name as string} sub={when as string} dot={job(key as string, name as string)} />
          ))}
          <Node x={246} y={290} w={150} h={38} title="options job" sub="every 5 min, read" dot={dot("positions")} />
          <Node x={470} y={86} w={188} h={190} title="publisher" sub={["every 5 min:", "collect, sanitize,", "sign the snapshot"]} dot={job("dashboard", "publisher")} />

          {/* the runner starts the jobs and pages the phone */}
          <Edge diagram={id} d="M321 72 V86" />
          <Edge diagram={id} d="M564 72 V86" />
          <EdgeLabel x={330} y={82} anchor="start">
            starts each job
          </EdgeLabel>
          <Edge diagram={id} d="M658 58 H690 V35 H760" tone="warn" />
          <EdgeLabel x={724} y={30}>
            alerts, pings
          </EdgeLabel>

          {/* Alpaca A ⇄ the robot's jobs */}
          <Edge diagram={id} d="M200 100 H246" tone="info" flow />
          <Edge diagram={id} d="M200 146 H246" tone="info" flow />
          <Edge diagram={id} d="M246 162 H200" tone="good" />
          <Edge diagram={id} d="M200 200 H246" tone="info" flow />
          <EdgeLabel x={230} y={96}>
            bars
          </EdgeLabel>
          <EdgeLabel x={230} y={142}>
            bars
          </EdgeLabel>
          <EdgeLabel x={230} y={175}>
            orders
          </EdgeLabel>
          <EdgeLabel x={230} y={196}>
            bars
          </EdgeLabel>
          {/* forward's ledger feeds the weekly scorecard; all four write the state the publisher collects */}
          <Edge diagram={id} d="M300 220 V238" tone="info" />
          <EdgeLabel x={308} y={233} anchor="start">
            ledger
          </EdgeLabel>
          {[105, 153, 201, 257].map((y) => (
            <Edge key={y} diagram={id} d={`M396 ${y} H470`} tone="info" flow />
          ))}
          <EdgeLabel x={433} y={129}>
            state files
          </EdgeLabel>
          {/* Alpaca B → options job */}
          <Edge diagram={id} d="M200 309 H246" tone="info" flow />
          <EdgeLabel x={228} y={304}>
            positions
          </EdgeLabel>

          {/* host → ingest */}
          <Edge diagram={id} d="M658 177 H704" tone="info" flow />
          <EdgeLabel x={681} y={172}>
            snapshot
          </EdgeLabel>
          <Edge diagram={id} d="M396 309 H704" tone="info" flow />
          <EdgeLabel x={560} y={304}>
            positions
          </EdgeLabel>

          {/* the scheduled tasks */}
          <Node x={392} y={404} w={118} h={40} title="focus" sub="pre-open 08:50" dot={dot("levels")} />
          <Node x={540} y={404} w={118} h={40} title="levels" sub={`after close ${hhmm(utcToNy(LEVELS_UTC, now))}`} dot={dot("levels")} />
          <Node x={246} y={472} w={132} h={40} title="radar build" sub={hhmm(utcToNy(RADAR_UTC, now))} dot={dot("radar")} />
          <Node x={540} y={472} w={118} h={40} title="radar send" sub={hhmm(utcToNy(RADAR_SEND_UTC, now))} dot={dot("radar")} />
          <Node x={246} y={532} w={132} h={38} title="Webull sync" sub="every 2 min" dot={dot("journal")} />
          <Node x={246} y={580} w={132} h={38} title="Webull backstop" sub={`after close ${hhmm(utcToNy(WEBULL_BACKSTOP_UTC, now))}`} dot={dot("journal")} />
          <T x={392} y={636} muted>
            Times are New York. None can place an order.
          </T>

          {/* IBKR → focus, levels, radar */}
          <Edge diagram={id} d="M200 424 H392" tone="info" flow />
          <EdgeLabel x={300} y={419}>
            last prices
          </EdgeLabel>
          <Edge diagram={id} d="M200 458 H599 V444" tone="info" flow />
          <EdgeLabel x={300} y={454}>
            bars, implied vol
          </EdgeLabel>
          <Edge diagram={id} d="M200 492 H246" tone="info" flow />
          <EdgeLabel x={228} y={487}>
            lists
          </EdgeLabel>
          {/* inside the tasks */}
          <Edge diagram={id} d="M540 432 H510" tone="info" />
          <EdgeLabel x={525} y={427}>
            pick
          </EdgeLabel>
          <Edge diagram={id} d="M378 492 H540" tone="info" />
          <EdgeLabel x={459} y={487}>
            outbox
          </EdgeLabel>
          {/* Webull → sync, backstop */}
          <Edge diagram={id} d="M200 551 H246" tone="info" flow />
          <Edge diagram={id} d="M200 599 H246" tone="info" flow />
          <EdgeLabel x={228} y={546}>
            trades
          </EdgeLabel>
          <EdgeLabel x={228} y={594}>
            trades
          </EdgeLabel>

          {/* tasks → ingest */}
          <Edge diagram={id} d="M451 404 V392 H704" tone="info" flow />
          <EdgeLabel x={600} y={388}>
            focus, when switched on
          </EdgeLabel>
          <Edge diagram={id} d="M658 418 H704" tone="info" flow />
          <EdgeLabel x={681} y={413}>
            levels
          </EdgeLabel>
          <Edge diagram={id} d="M658 492 H704" tone="info" flow />
          <EdgeLabel x={681} y={487}>
            radar
          </EdgeLabel>
          <Edge diagram={id} d="M378 551 H704" tone="info" flow />
          <Edge diagram={id} d="M378 599 H704" tone="info" flow />
          <EdgeLabel x={560} y={546}>
            journal
          </EdgeLabel>
          <EdgeLabel x={560} y={594}>
            journal
          </EdgeLabel>

          {/* ingest → pages, one arrow per feed */}
          {[177, 309, 392, 418, 492, 551, 599].map((y) => (
            <Edge key={y} diagram={id} d={`M738 ${y} H754`} tone="info" />
          ))}
          {/* the watchdog reads the snapshot's age and pages the phone */}
          <Edge diagram={id} d="M890 177 H904" tone="info" />
          <Edge diagram={id} d="M944 150 V56" tone="warn" />
          <EdgeLabel x={948} y={110} anchor="start">
            late
          </EdgeLabel>
          {/* live prices: the site's own quote route, never the ingest */}
          <Edge diagram={id} d="M200 678 H995 V365 H984" tone="info" flow />
          <EdgeLabel x={600} y={673}>
            quotes, through the site&apos;s own route
          </EdgeLabel>
          <Edge diagram={id} d="M904 365 H890" tone="info" />
        </Diagram>
      </Figure>
      <Why title="Why two places do the work.">
        The host runs what must happen at an exact second and trade on paper: the robot, its stops, the five-minute publishers. The
        scheduled tasks do the reading and research that needs Claude and your read-only accounts: the radar, the levels and your
        Webull trades. Every feed is checked against its own schema when it arrives, so one bad feed cannot break another page.
      </Why>
    </WikiSection>
  );
}

// ---- is the data fresh ----------------------------------------------------------------------------------------------

export function FeedsSection({ feeds, now }: { feeds: Feed[]; now: Date }) {
  return (
    <WikiSection
      id="feeds"
      eyebrow="Stocks desk"
      title="Is the data fresh?"
      lede="Each feed against its own schedule. A late feed means its page shows older data than it should; the page itself still works."
    >
      <ul className="bg-card divide-border grid divide-y rounded-lg border" aria-label="The Stocks site's data feeds">
        {feeds.map((f) => (
          <li key={f.key} className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 items-start gap-2.5">
              <ToneDot tone={FEED_TONE[f.state]} className="mt-1.5" />
              <div className="min-w-0">
                <a href={f.href} className="text-sm font-medium hover:underline">
                  {f.page}
                </a>
                <p className="text-muted-foreground text-xs">{f.what}</p>
              </div>
            </div>
            <div className="min-w-0 text-xs">
              <p>{f.by}</p>
              <p className="text-muted-foreground">{f.when}</p>
            </div>
            <div className="min-w-0 text-xs">
              <p className={f.state === "fresh" ? "text-good" : f.state === "late" ? "text-warn" : f.state === "error" ? "text-bad" : "text-muted-foreground"}>
                {feedWord(f, now)}
              </p>
              <p className="text-muted-foreground">
                {f.asOf ? `${sydney(f.asOf)} Sydney` : "—"}
                {f.note ? ` · ${f.note}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground max-w-prose text-xs">
        The five-minute feeds are late after {LATE_MIN} minutes. The levels are late once a session starts without its own edition, the radar
        once the bell rings on an older edition, and your trades once a session or the evening backstop passes without an update. A US
        holiday can read as late. The live prices on the Options page are fetched when you look, so they have no feed.
      </p>
    </WikiSection>
  );
}

// ---- a trading day --------------------------------------------------------------------------------------------------

export function DaySection({ s, feeds, now }: { s: Snapshot | null; feeds: Feed[]; now: Date }) {
  const id = "dg-day";
  const START = 5 * 60;
  const END = 18 * 60 + 30;
  const X0 = 150;
  const W = 980;
  const HR = (W - X0 - 20) / ((END - START) / 60);
  const x = (min: number) => X0 + ((min - START) / 60) * HR;
  const last = new Map(entries(s?.jobs?.last));
  const nowMin = nyMinutes(now);
  const showNow = nowMin >= START && nowMin <= END;
  const syd = sydneyAheadOfNy(now);
  const radar = utcToNy(RADAR_UTC, now);
  const send = utcToNy(RADAR_SEND_UTC, now);
  const backstop = utcToNy(WEBULL_BACKSTOP_UTC, now);
  const levels = utcToNy(LEVELS_UTC, now);
  const feed = (k: FeedKey) => feeds.find((f) => f.key === k);
  const fdot = (k: FeedKey, name: string) => {
    const f = feed(k);
    return f ? { tone: FEED_TONE[f.state], word: `${name}: ${feedWord(f, now)}` } : { tone: "neutral" as Tone, word: name };
  };
  const jdot = (key: string, name: string) => {
    const d = jobDot(last.get(key));
    return { tone: d.tone, word: `${name}: last run ${d.word}` };
  };
  const ROW = 38;
  const TOP = 44;
  const lanes: { name: string; where: "host" | "task"; dot: { tone: Tone; word: string } }[] = [
    { name: "radar", where: "task", dot: fdot("radar", "radar") },
    { name: "routine", where: "host", dot: jdot("routine", "routine") },
    { name: "focus", where: "task", dot: fdot("levels", "focus") },
    { name: GAP_HUNTER.name, where: "host", dot: jdot(GAP_HUNTER.job, GAP_HUNTER.name) },
    { name: "options job", where: "host", dot: fdot("positions", "options job") },
    { name: "Webull sync", where: "task", dot: fdot("journal", "Webull sync") },
    { name: "forward", where: "host", dot: jdot("forward", "forward") },
    { name: "levels", where: "task", dot: fdot("levels", "levels") },
    { name: "publisher", where: "host", dot: jdot("dashboard", "publisher") },
  ];
  const y = (i: number) => TOP + i * ROW;
  const H = TOP + lanes.length * ROW + 52;
  const bottom = TOP + lanes.length * ROW - 8;
  const hours = Array.from({ length: Math.floor((END - START) / 60) + 1 }, (_, i) => START / 60 + i);
  const bar = (i: number, from: number, to: number, kind: "wait" | "work" | "score") => (
    <rect
      x={x(from)}
      y={y(i)}
      width={Math.max(3, x(to) - x(from))}
      height={22}
      rx={4}
      style={
        kind === "wait"
          ? { fill: "var(--muted)", stroke: "var(--border)" }
          : kind === "score"
            ? { fill: "var(--info-soft)", stroke: "var(--info-fill)" }
            : { fill: "var(--good-soft)", stroke: "var(--good-fill)" }
      }
    />
  );
  const ticks = (i: number, from: number, to: number, every: number, key: string, tone = "var(--good-fill)") =>
    Array.from({ length: Math.floor((to - from) / every) + 1 }, (_, k) => (
      <rect key={`${key}-${k}`} x={x(from + k * every) - 0.7} y={y(i)} width={1.4} height={22} style={{ fill: tone, opacity: 0.8 }} />
    ));
  const note = (i: number, at: number, text: string, muted = true) => (
    <T x={x(at) + 6} y={y(i) + 15} muted={muted}>
      {text}
    </T>
  );
  const label = `A trading day in New York time, 05:00 to 18:30, with Sydney time underneath. Scheduled tasks: the radar builds at ${hhmm(radar)} and is sent at ${hhmm(send)}; the focus heads-up at 08:50; your Webull trades sync every 2 minutes from 09:24 to 16:20, with a backstop at ${hhmm(backstop)}; the levels and the next focus are built at ${hhmm(levels)}. Host jobs: the routine plans before the open; Gap Hunter scans from the open and is flat by the close; the options job and the publisher send every 5 minutes; the forward test scores after the close.${
    showNow ? ` Now is ${hhmm(nowMin)} New York.` : ""
  } ${lanes.map((l) => l.dot.word).join("; ")}.`;
  return (
    <WikiSection
      id="day"
      eyebrow="Stocks desk"
      title="A trading day"
      lede="Everything that runs for the Stocks site on one weekday, host jobs and scheduled tasks together. Host jobs follow New York time; the cloud tasks that run on UTC move an hour against it when US clocks change."
    >
      <Figure
        minWidth={820}
        caption={
          <>
            <b className="text-foreground font-medium">The day on both clocks.</b> Grey is a job waiting, green is work, blue is scoring,
            thin lines are single runs. The blue band is the US cash session. {showNow ? "The dashed line is now." : "Outside these hours the line for now is hidden."}
          </>
        }
      >
        <Diagram id={id} w={W} h={H} label={label}>
          <rect x={x(9 * 60 + 30)} y={TOP - 10} width={x(16 * 60) - x(9 * 60 + 30)} height={bottom - TOP + 10} style={{ fill: "var(--info-soft)" }} />
          <T x={x(12 * 60 + 45)} y={TOP - 16} muted anchor="middle">
            cash session 09:30–16:00
          </T>
          {hours.map((h) => (
            <g key={h}>
              <line x1={x(h * 60)} y1={TOP - 10} x2={x(h * 60)} y2={bottom} style={{ stroke: "var(--chart-grid)" }} />
              <T x={x(h * 60)} y={bottom + 18} mono muted anchor="middle" size={10.5}>
                {`${String(h).padStart(2, "0")}:00`}
              </T>
              {h % 2 === 1 ? (
                <T x={x(h * 60)} y={bottom + 38} mono muted anchor="middle" size={10.5}>
                  {hhmm(h * 60 + syd)}
                </T>
              ) : null}
            </g>
          ))}
          <T x={20} y={bottom + 18} caps>
            New York
          </T>
          <T x={20} y={bottom + 38} caps>
            Sydney
          </T>
          {lanes.map((l, i) => (
            <g key={l.name}>
              <Dot cx={24} cy={y(i) + 11} tone={l.dot.tone} title={l.dot.word} />
              <T x={36} y={y(i) + 10}>
                {l.name}
              </T>
              <T x={36} y={y(i) + 23} muted size={10}>
                {l.where === "host" ? "host" : "scheduled task"}
              </T>
            </g>
          ))}
          {/* radar: build, then the send from the outbox */}
          {bar(0, radar, radar + 35, "work")}
          <rect x={x(send) - 1} y={y(0)} width={3} height={22} style={{ fill: "var(--info-fill)" }} />
          {note(0, send, "sent")}
          {/* routine */}
          {bar(1, 7 * 60 + 30, 7 * 60 + 55, "wait")}
          {bar(1, 7 * 60 + 55, 9 * 60 + 15, "work")}
          {note(1, 9 * 60 + 15, "scans, ranks and plans")}
          {/* focus heads-up */}
          {bar(2, 8 * 60 + 50, 9 * 60 + 5, "work")}
          {note(2, 9 * 60 + 5, "top 4 heads-up before the bell")}
          {/* Gap Hunter's session */}
          {bar(3, 8 * 60 + 30, 9 * 60 + 30, "wait")}
          {bar(3, 9 * 60 + 30, 16 * 60, "work")}
          <T x={x(9 * 60 + 30) + 8} y={y(3) + 15}>
            scans from the open, flat by the close
          </T>
          {/* options job: every 5 minutes in the session */}
          {ticks(4, 9 * 60 + 4, 16 * 60 + 59, 5, "opt")}
          {/* Webull sync: every 2 minutes, then the backstop */}
          {ticks(5, 9 * 60 + 24, 16 * 60 + 20, 2, "wb", "var(--info-fill)")}
          <rect x={x(backstop) - 1} y={y(5)} width={3} height={22} style={{ fill: "var(--info-fill)" }} />
          {note(5, backstop, "backstop")}
          {/* forward */}
          {bar(6, 12 * 60 + 40, 16 * 60 + 20, "wait")}
          {bar(6, 16 * 60 + 20, 17 * 60, "score")}
          <T x={x(12 * 60 + 40) + 8} y={y(6) + 15} muted>
            waits for the close + 20 min
          </T>
          {/* levels and the next focus */}
          {bar(7, levels, levels + 25, "work")}
          <T x={x(levels) - 6} y={y(7) + 15} muted anchor="end">
            levels, zones and the next top 4
          </T>
          {/* publisher: every 5 minutes 07:00 to 17:55, every 15 otherwise */}
          {ticks(8, START + 3, 7 * 60, 15, "pub-am")}
          {ticks(8, 7 * 60 + 3, 17 * 60 + 58, 5, "pub")}
          {ticks(8, 18 * 60 + 3, END, 15, "pub-pm")}
          {showNow ? (
            <g>
              <line x1={x(nowMin)} y1={TOP - 10} x2={x(nowMin)} y2={bottom} style={{ stroke: "var(--info-fill)" }} strokeWidth={1.5} strokeDasharray="3 3" />
              <T x={x(nowMin) + 4} y={TOP - 2} size={11}>
                now
              </T>
            </g>
          ) : null}
        </Diagram>
      </Figure>
      <Why title="Why the order matters.">
        The radar and the routine finish before the bell, so the Radar page and the robot&apos;s plan are ready at the open. The forward
        test waits until 20 minutes after the close so the free data feed&apos;s delay has passed. The levels for the next session are built
        only after the close, from that day&apos;s final bars.
      </Why>
    </WikiSection>
  );
}

const GUARDS: { name: string; entryOnly: boolean }[] = [
  { name: "paper lock", entryOnly: false },
  { name: "symbol allowlist", entryOnly: false },
  { name: "sell within long position", entryOnly: false },
  { name: "quantity and notional caps", entryOnly: false },
  { name: "kill switch off", entryOnly: true },
  { name: "loss latch clear", entryOnly: true },
  { name: "market open", entryOnly: true },
  { name: "entries and orders per day", entryOnly: true },
  { name: "flat, no duplicate order", entryOnly: true },
];

export function OrdersSection({ s }: { s: Snapshot }) {
  const id = "dg-orders";
  const kill = s.kill?.on === true;
  const latched = s.ops?.paper?.virtual?.latched === true;
  const live: Record<string, { tone: Tone; word: string }> = {
    "kill switch off": kill ? { tone: "warn", word: "kill switch is ON: entries refused" } : { tone: "good", word: "kill switch off" },
    "loss latch clear": latched ? { tone: "bad", word: "loss latch is SET: entries refused" } : { tone: "good", word: "loss latch clear" },
  };
  const states: { k: string; x: number; y: number; tone?: Tone }[] = [
    { k: "planned", x: 380, y: 52 },
    { k: "submitting", x: 560, y: 52 },
    { k: "entry working", x: 740, y: 52 },
    { k: "in position", x: 740, y: 150, tone: "good" },
    { k: "exiting", x: 560, y: 150 },
    { k: "closed", x: 380, y: 150, tone: "good" },
    { k: "aborted", x: 650, y: 248, tone: "bad" },
  ];
  return (
    <WikiSection
      id="orders"
      eyebrow="Stocks desk"
      title="The paper robot's safety"
      lede="The only code here that places orders is the paper robot, and only on Alpaca's paper account. Every order passes the pre-trade guard, and every plan moves through one small state machine that survives a restart."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">The guard and the plan.</b> Starred checks apply to entries only; exits and stops skip
            them, so a risk-reducing order always gets through. The kill switch and latch dots are live.
          </>
        }
      >
        <Diagram
          id={id}
          w={960}
          h={330}
          label={`Order safety. Every order passes the pre-trade guard: ${GUARDS.map((g) => g.name).join(", ")}. Kill switch ${kill ? "on" : "off"}, loss latch ${latched ? "set" : "clear"}. A plan moves planned, submitting, entry working, in position, exiting, closed; an entry that never fills is aborted.`}
        >
          <Zone x={20} y={14} w={320} h={300} label="Pre-trade guard" />
          {GUARDS.map((g, i) => {
            const l = live[g.name];
            return (
              <g key={g.name}>
                <Dot cx={42} cy={58 + i * 28} tone={l?.tone ?? "neutral"} title={l?.word ?? `${g.name}: checked on every ${g.entryOnly ? "entry" : "order"}`} r={4} />
                <T x={56} y={62 + i * 28}>
                  {`${g.name}${g.entryOnly ? " *" : ""}`}
                </T>
              </g>
            );
          })}
          <Edge diagram={id} d="M340 72 H380" tone="good" />
          {states.map((st) => (
            <g key={st.k}>
              <rect
                x={st.x}
                y={st.y}
                width={140}
                height={40}
                rx={20}
                style={{
                  fill: st.tone ? `color-mix(in srgb, ${TONE_VAR[st.tone]} 12%, var(--card))` : "var(--card)",
                  stroke: st.tone ? TONE_VAR[st.tone] : "var(--border)",
                }}
              />
              <T x={st.x + 70} y={st.y + 25} anchor="middle">
                {st.k}
              </T>
            </g>
          ))}
          <Edge diagram={id} d="M520 72 H560" />
          <Edge diagram={id} d="M700 72 H740" />
          <Edge diagram={id} d="M850 92 V150" tone="good" />
          <EdgeLabel x={858} y={126} anchor="start">
            first fill
          </EdgeLabel>
          <Edge diagram={id} d="M740 170 H700" />
          <Edge diagram={id} d="M560 170 H520" tone="good" />
          <Edge diagram={id} d="M630 92 C 630 190, 700 200, 712 248" tone="bad" dash />
          <Edge diagram={id} d="M770 92 C 780 190, 760 220, 742 248" tone="bad" dash />
          <EdgeLabel x={700} y={232}>
            no fill, or refused
          </EdgeLabel>
          <T x={380} y={226} muted>
            Every transition is saved, so a restart
          </T>
          <T x={380} y={241} muted>
            resumes the plan instead of re-entering.
          </T>
          <T x={380} y={290} muted>
            A server-side GTC stop rests at the broker from the first fill;
          </T>
          <T x={380} y={305} muted>
            an exit cancels it, confirms the cancel, then sells.
          </T>
        </Diagram>
      </Figure>
      <div className="flex flex-wrap gap-2">
        <StatusBadge tone={kill ? "warn" : "good"}>{kill ? "Kill switch on: entries refused" : "Kill switch off"}</StatusBadge>
        <StatusBadge tone={latched ? "bad" : "good"}>{latched ? "Loss latch set" : "Loss latch clear"}</StatusBadge>
      </div>
      <Why title="Why the broker is the source of truth.">
        Each order has its own client id, so after a timeout it is found by id rather than sent twice. Reconciliation
        protects any unprotected position and cancels this strategy&apos;s stray orders, never another&apos;s.
      </Why>
    </WikiSection>
  );
}

export function GatesSection({ s }: { s: Snapshot }) {
  const id = "dg-gates";
  const gates = list(s.overview?.gates);
  if (gates.length === 0) return null;
  const X0 = 80;
  const step = Math.min(130, 800 / Math.max(1, gates.length - 1));
  const cur = currentGate(gates);
  return (
    <WikiSection
      id="gates"
      eyebrow="Stocks desk"
      title="Research gates"
      lede="A strategy reaches real money only by clearing each gate in order. The current gate is ringed; the Research page has the evidence."
    >
      <Figure caption={<><b className="text-foreground font-medium">The gate rail.</b> Green passed, red failed, blue in progress, grey not started.</>}>
        <Diagram
          id={id}
          w={960}
          h={170}
          label={`Research gates: ${gates.map((g) => `${g.id} ${g.name} ${String(g.status ?? "").replace(/_/g, " ")}${g.progress ? ` (${g.progress})` : ""}`).join("; ")}.`}
        >
          <line x1={X0} y1={56} x2={X0 + step * (gates.length - 1)} y2={56} style={{ stroke: "var(--border)" }} strokeWidth={2} />
          {gates.map((g, i) => {
            const cx = X0 + i * step;
            const tone = gateTone(g.status);
            const isCur = cur?.id === g.id;
            return (
              <g key={`${g.id}-${i}`}>
                {isCur ? <circle cx={cx} cy={56} r={17} className="wiki-pulse" style={{ fill: "none", stroke: TONE_VAR[tone] }} strokeWidth={2} /> : null}
                <circle cx={cx} cy={56} r={11} style={{ fill: TONE_VAR[tone] }}>
                  <title>{`${g.id} ${g.name}: ${String(g.status ?? "").replace(/_/g, " ")}`}</title>
                </circle>
                <T x={cx} y={98} anchor="middle" weight={600}>
                  {txt(g.id)}
                </T>
                <T x={cx} y={116} anchor="middle" muted>
                  {txt(g.name)}
                </T>
                <T x={cx} y={134} anchor="middle" muted size={10.5}>
                  {String(g.status ?? "").replace(/_/g, " ")}
                </T>
                {g.progress ? (
                  <T x={cx} y={152} anchor="middle" size={10.5}>
                    {g.progress}
                  </T>
                ) : null}
              </g>
            );
          })}
        </Diagram>
      </Figure>
    </WikiSection>
  );
}

const ADRS = [
  { id: "0001", title: "Dashboard on Vercel, fed by a signed push", status: "accepted" },
  { id: "0002", title: "Runtime state outside git, computed deploy gate", status: "accepted" },
  { id: "0004", title: "Trading host on OCI (it runs on GCP instead)", status: "not taken" },
  { id: "0005", title: "Desks: stocks and crypto", status: "accepted" },
  { id: "0006", title: "An external desk on the status site", status: "accepted" },
  { id: "0007", title: "The host says when a deploy is ready", status: "accepted" },
  { id: "0008", title: "The host deploys itself, inside the same gate", status: "accepted" },
];

const RUNBOOKS: { file: string; when: string }[] = [
  { file: "gcp-host", when: "the host runs old code, or you need to deploy, install units or rebuild" },
  { file: "not-flat-at-close", when: "p5 “NOT FLAT at the close”, a red banner" },
  { file: "position-alerts", when: "“adopted a position”, “exits only”, “clock check failed”" },
  { file: "latch-reset", when: "p5 “loss limit latched”; entries stay off" },
  { file: "kill-and-flatten", when: "you want the paper robot to stop now" },
  { file: "paper-options", when: "the Paper page has no history, says it is old, or a total looks wrong" },
  { file: "dashboard-late", when: "“Dashboard late”, a grey or amber freshness pill" },
  { file: "rollback", when: "the next night's jobs fail after a deploy" },
  { file: "disk-full", when: "p3 “refused to run: free disk”" },
  { file: "dead-man-switches", when: "a healthchecks.io page" },
  { file: "secret-rotation", when: "a secret may have leaked" },
];

export function RunbooksSection() {
  return (
    <WikiSection
      id="runbooks"
      eyebrow="Stocks desk"
      title="Runbooks and decisions"
      lede="What to open when something pages or a feed is late, and the architecture decisions the design rests on. Both live in the repo's docs/ folder."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="bg-card rounded-lg border p-4">
          <p className="text-muted-foreground mb-2 text-[0.6875rem] tracking-wider uppercase max-sm:text-xs">You see → open</p>
          <ul className="grid gap-1.5 text-sm">
            {RUNBOOKS.map((r) => (
              <li key={r.file} className="flex flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 flex-1">{r.when}</span>
                <span className="text-muted-foreground font-mono text-xs">docs/runbooks/{r.file}.md</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-card rounded-lg border p-4">
          <p className="text-muted-foreground mb-2 text-[0.6875rem] tracking-wider uppercase max-sm:text-xs">Architecture decisions</p>
          <ul className="grid gap-2 text-sm">
            {ADRS.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-xs font-semibold">ADR {a.id}</span>
                <span className="min-w-0 flex-1">{a.title}</span>
                <StatusBadge tone={a.status === "accepted" ? "good" : "neutral"}>{a.status}</StatusBadge>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {num(RUNBOOKS.length)} of the runbooks most likely at 3 a.m.; the full index is docs/runbooks/README.md. The scheduled tasks are
        Claude routines in this project: when one fails it says so in its own thread.
      </p>
    </WikiSection>
  );
}
