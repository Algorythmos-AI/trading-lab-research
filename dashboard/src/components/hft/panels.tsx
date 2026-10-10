import {
  ArrowLeftRight,
  CircleCheck,
  CloudOff,
  FlaskConical,
  GraduationCap,
  Inbox,
  Landmark,
  Layers,
  ListChecks,
  Milestone,
  MoonStar,
  Power,
  Radio,
  Scale,
  Workflow,
} from "lucide-react";
import { RelativeTime } from "@/components/client/relative-time";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status";
import { StepRail, type RailState } from "@/components/step-rail";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DASH, num, zoned } from "@/lib/format";
import { FORM, MODE, RECORDER, SLEEVE, SLEEVE_STAGE, STAGE, VENUE, look, megabytes, net, phaseLine, phases, rows, spread, words, type Hft } from "@/lib/hft";
import type { HftResult } from "@/lib/snapshot";

/** What the page will hold, said in words only: before the desk publishes, nothing here may look like a reading. */
const SECTIONS: readonly (readonly [string, string])[] = [
  ["Status", "The desk's mode, stage and venue, whether its market is open, and its kill switch."],
  ["Build phases", "The platform's phases F0 to F7 and how far each has got."],
  ["Recorder", "Whether quotes are being recorded, how many events today, and any gaps nobody can explain."],
  ["Pairs", "Each currency pair being recorded, with its quote rate and median spread."],
  ["Sleeves", "Each strategy sleeve, the stage it runs at, and its results today and in total."],
  ["Books", "The desk's shadow book beside the broker's, and how often the two disagreed."],
  ["Learning", "The model in force, its challengers, and the last training, promotion and rollback."],
];

/** What the HFT page shows before the desk has published, or when storage cannot be read. Never an error page. */
export function NoHftSnapshot({ status }: { status: Exclude<HftResult["status"], "ok"> }) {
  if (status === "error") {
    return (
      <Empty icon={CloudOff} title="Storage could not be read">
        The dashboard could not read the HFT desk&apos;s snapshot. It retries every minute.
      </Empty>
    );
  }
  return (
    <>
      <Empty icon={Inbox} title="The HFT desk has not published yet">
        Nothing has reached this site from the desk, so there is nothing to show. This page fills in when the desk&apos;s
        recorder starts, and it checks again every minute.
      </Empty>
      <Panel title="What this page will show" icon={ListChecks} means="Each part appears once the desk publishes it. Until then this page holds no readings.">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {SECTIONS.map(([name, what]) => (
            <div key={name} className="min-w-0">
              <dt className="text-sm font-medium">{name}</dt>
              <dd className="text-muted-foreground text-[0.8125rem]">{what}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </>
  );
}

/** A published time: the UTC wall time from the server, then "12 min ago" once the browser knows the time. */
function When({ iso }: { iso: string | null | undefined }) {
  if (typeof iso !== "string" || !iso) return <>{DASH}</>;
  return <RelativeTime iso={iso} fallback={`${zoned(iso, "UTC")} UTC`} />;
}

/**
 * The site's table inside a scroll area that takes keyboard focus, so on a narrow screen the arrow keys can move a
 * wide table sideways. The page itself never scrolls sideways.
 */
function ScrollTable({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="relative w-full overflow-x-auto">
      <table className="w-full caption-bottom text-[0.8125rem]">{children}</table>
    </div>
  );
}

/** Mode, stage, venue, market and kill switch. Every tile says its state in words; the colour only repeats it. */
export function HftStatus({ s }: { s: Hft }) {
  const d = s.desk;
  const open = d?.market_open === true;
  const kill = d?.kill === true;
  return (
    <section aria-label="Desk status">
      <StatTiles className="lg:grid-cols-5">
        <StatTile label="Mode" value={words(MODE, d?.mode)} hint="Paper is the only mode the desk's contract allows." icon={FlaskConical} />
        <StatTile label="Stage" value={words(STAGE, d?.stage)} hint="One of foundation, recording, shadow and paper." icon={Workflow} tone="info" />
        <StatTile label="Venue" value={words(VENUE, d?.venue)} hint="The broker's paper account, or the desk's own simulator." icon={Landmark} />
        <StatTile
          label="Market"
          value={d?.market_open == null ? DASH : open ? "Open" : "Closed"}
          hint="As the desk reports it."
          icon={open ? CircleCheck : MoonStar}
          tone={open ? "good" : "neutral"}
        />
        <StatTile
          className="col-span-2 lg:col-span-1"
          label="Kill switch"
          value={d?.kill == null ? DASH : kill ? "On" : "Off"}
          hint={`Flatten switch: ${d?.flatten == null ? DASH : d.flatten ? "on" : "off"}.`}
          icon={Power}
          tone={kill || d?.flatten === true ? "warn" : "neutral"}
        />
      </StatTiles>
    </section>
  );
}

const RAIL: Record<string, RailState> = { done: "done", open: "current", not_started: "todo" };
/** A state this build does not know is drawn as not yet reached. */
const rail = (state: string): RailState => (Object.hasOwn(RAIL, state) ? RAIL[state]! : "todo");

/** Build phases F0 to F7 as one track, each with its state in words. */
export function HftPhases({ s }: { s: Hft }) {
  const list = phases(s);
  return (
    <Panel title="Build phases" icon={Milestone} means="The platform is built in phases, F0 to F7. This is how far each one has got, as the desk reports it.">
      {list.length === 0 ? (
        <Empty title="No build phases reported yet" />
      ) : (
        <div className="grid gap-3">
          <StepRail label="Build phases in order" steps={list.map((p, i) => ({ key: `${p.id}:${i}`, label: p.id, state: rail(p.state) }))} />
          <p className="text-[0.8125rem]">{phaseLine(list)}</p>
        </div>
      )}
    </Panel>
  );
}

export function HftRecorder({ s }: { s: Hft }) {
  const r = s.recorder;
  const state = look(RECORDER, r?.state);
  const gaps = r?.gaps_unexplained_today;
  return (
    <Panel title="Recorder" icon={Radio} means="The recorder writes down the quotes the desk receives. The counts are for the desk's current day.">
      {!r ? (
        <Empty title="No recorder status yet" />
      ) : (
        <KeyValues
          items={[
            { label: "State", value: <StatusBadge tone={state.tone}>{state.label}</StatusBadge> },
            { label: "Events today", value: num(r.events_today), mono: true },
            { label: "Last event", value: <When iso={r.last_event_at} /> },
            {
              label: "Unexplained gaps today",
              value: typeof gaps === "number" && gaps > 0 ? <StatusBadge tone="warn">{num(gaps)}</StatusBadge> : num(gaps),
              mono: !(typeof gaps === "number" && gaps > 0),
            },
            { label: "Disk used", value: megabytes(r.disk_used_mb), mono: true },
          ]}
        />
      )}
    </Panel>
  );
}

export function HftPairs({ s }: { s: Hft }) {
  const list = rows(s.pairs);
  return (
    <Panel title="Pairs" icon={ArrowLeftRight} means="The currency pairs being recorded. The spread is the median gap between the buy and sell quotes, in price units.">
      {list.length === 0 ? (
        <Empty title="No pairs yet" />
      ) : (
        <ScrollTable label="Currency pairs">
          <TableHeader>
            <TableRow>
              <TableHead>Pair</TableHead>
              <TableHead>Form</TableHead>
              <TableHead>Last quote</TableHead>
              <TableHead className="text-right">Updates a second</TableHead>
              <TableHead className="text-right">Median spread</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((p, i) => (
              <TableRow key={`${p.pair}:${i}`}>
                <TableCell className="font-mono font-medium">{p.pair}</TableCell>
                <TableCell>{words(FORM, p.form)}</TableCell>
                <TableCell>
                  <When iso={p.last_quote_at} />
                </TableCell>
                <TableCell className="text-right font-mono">{num(p.updates_per_second, 1)}</TableCell>
                <TableCell className="text-right font-mono">{spread(p.spread_median)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ScrollTable>
      )}
    </Panel>
  );
}

export function HftSleeves({ s }: { s: Hft }) {
  const list = rows(s.sleeves);
  return (
    <Panel
      title="Sleeves"
      icon={Layers}
      means="A sleeve is one strategy running on the desk, with its own stage and its own results. Results are paper money."
    >
      {list.length === 0 ? (
        <Empty title="No sleeves yet" />
      ) : (
        <ScrollTable label="Sleeves">
          <TableHeader>
            <TableRow>
              <TableHead>Sleeve</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Trades today</TableHead>
              <TableHead className="text-right">Trades in total</TableHead>
              <TableHead className="text-right">Net today</TableHead>
              <TableHead className="text-right">Net in total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((v, i) => {
              const stage = look(SLEEVE_STAGE, v.stage);
              return (
                <TableRow key={`${v.name}:${i}`}>
                  <TableCell className="font-medium">{words(SLEEVE, v.name)}</TableCell>
                  <TableCell>
                    <StatusBadge tone={stage.tone}>{stage.label}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{num(v.trades_today)}</TableCell>
                  <TableCell className="text-right font-mono">{num(v.trades_total)}</TableCell>
                  <TableCell className="text-right font-mono">{net(v.net_today, v.currency)}</TableCell>
                  <TableCell className="text-right font-mono">{net(v.net_total, v.currency)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </ScrollTable>
      )}
    </Panel>
  );
}

function Book({ name, note, today, total }: { name: string; note: string; today: string; total: string }) {
  return (
    <div className="bg-muted/40 min-w-0 rounded-md border px-3 py-3">
      <h3 className="text-sm font-medium">{name}</h3>
      <p className="text-muted-foreground text-xs">{note}</p>
      <KeyValues
        className="mt-3 sm:grid-cols-2"
        items={[
          { label: "Net today", value: today, mono: true },
          { label: "Net in total", value: total, mono: true },
        ]}
      />
    </div>
  );
}

export function HftBooks({ s }: { s: Hft }) {
  const b = s.books;
  const breaks = b?.reconciliation_breaks_today;
  return (
    <Panel title="Books" icon={Scale} means="The desk keeps its own conservative book beside the broker's and compares the two. A break is a moment when they disagreed.">
      {!b ? (
        <Empty title="No books yet" />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Book name="Shadow book" note="The desk's own count" today={net(b.shadow?.net_today, b.currency)} total={net(b.shadow?.net_total, b.currency)} />
            <Book name="Broker book" note="The broker's count" today={net(b.broker?.net_today, b.currency)} total={net(b.broker?.net_total, b.currency)} />
          </div>
          <KeyValues
            className="sm:grid-cols-2"
            items={[
              {
                label: "Reconciliation breaks today",
                value:
                  typeof breaks !== "number" ? DASH : breaks > 0 ? <StatusBadge tone="warn">{num(breaks)}</StatusBadge> : <StatusBadge tone="good">None</StatusBadge>,
              },
              { label: "Open positions", value: num(b.open_positions), mono: true },
            ]}
          />
          <p className="text-muted-foreground text-xs">The shadow book is the result of record.</p>
        </div>
      )}
    </Panel>
  );
}

export function HftLearning({ s }: { s: Hft }) {
  const l = s.learning;
  return (
    <Panel title="Learning" icon={GraduationCap} means="The desk retrains its models every week. The champion is the model in force; challengers are the candidates to replace it.">
      {!l ? (
        <Empty title="No learning status yet" />
      ) : (
        <KeyValues
          items={[
            { label: "Champion", value: l.champion ?? "None", mono: l.champion != null },
            { label: "Challengers", value: num(l.challengers), mono: true },
            { label: "Last training", value: <When iso={l.last_training_at} /> },
            { label: "Last promotion", value: <When iso={l.last_promotion_at} /> },
            { label: "Last rollback", value: <When iso={l.last_rollback_at} /> },
          ]}
        />
      )}
    </Panel>
  );
}
