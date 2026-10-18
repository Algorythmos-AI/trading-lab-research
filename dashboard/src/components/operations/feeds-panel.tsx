import { Radio } from "lucide-react";
import Link from "next/link";
import { RelativeTime } from "@/components/client/relative-time";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { describeAge, freshness, OFFLINE_HOURS } from "@/lib/freshness";
import {
  dailyCheck,
  journalCheck,
  lastWeekdays,
  OPTIONS_SLOT_UTC,
  RADAR_SLOT_UTC,
  type FeedCheck,
  type FeedState,
} from "@/lib/feeds";
import { shortDate, sydney, weekDate } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { editionState } from "@/lib/options";
import type { JournalResult, OptionsLiveResult, OptionsResult, RadarResult, SnapshotResult } from "@/lib/snapshot";
import { list } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATE: Record<FeedState, { tone: Tone; label: string }> = {
  ok: { tone: "good", label: "On time" },
  due: { tone: "info", label: "Running now" },
  late: { tone: "warn", label: "Late" },
  missing: { tone: "neutral", label: "Nothing yet" },
  error: { tone: "bad", label: "Can't read" },
  info: { tone: "neutral", label: "No fixed time" },
};

interface Feed {
  key: string;
  name: string;
  href: string;
  state: FeedState;
  asOf: string | null;
  schedule: string;
  /** One extra fact from the edition, or a hint when the feed is late. */
  note?: React.ReactNode;
  strip?: { dates: string[]; have: Set<string>; today: string; label: string };
}

const sydTime = (iso: string | null) => (iso ? sydney(iso, false) : "—");

/** Late, missing or unreadable: what to do about a feed in a few words. */
function stateOf(status: "ok" | "missing" | "error", check: FeedCheck | null): FeedState {
  if (status !== "ok") return status;
  return check?.state ?? "info";
}

export interface FeedsInput {
  now: Date;
  snapshot: SnapshotResult;
  journal: JournalResult;
  options: OptionsResult;
  optionsLive: OptionsLiveResult;
  radar: RadarResult;
  optionsDates: string[];
  radarDates: string[];
}

export function buildFeeds(i: FeedsInput): Feed[] {
  const nowMs = i.now.getTime();
  const days = lastWeekdays(nowMs, 10);
  const today = days.at(-1)!;

  const j = i.journal.status === "ok" ? i.journal.doc : null;
  const jCheck = j ? journalCheck(j.as_of, nowMs) : null;
  const jState = stateOf(i.journal.status, jCheck);

  const o = i.options.status === "ok" ? i.options.edition : null;
  const oCheck = o ? dailyCheck(o.as_of, nowMs, OPTIONS_SLOT_UTC) : null;
  const oState = stateOf(i.options.status, oCheck);
  const oSession = o ? editionState(o.session, i.now) : null;

  const focus = o?.focus ?? null;
  const fCheck = focus?.picked_at ? dailyCheck(focus.picked_at, nowMs, OPTIONS_SLOT_UTC) : null;
  const fState: FeedState = i.options.status !== "ok" ? i.options.status : !focus ? "missing" : (fCheck?.state ?? "info");
  const pre = focus?.premarket?.as_of ?? null;

  const r = i.radar.status === "ok" ? i.radar.edition : null;
  const rCheck = r ? dailyCheck(r.as_of, nowMs, RADAR_SLOT_UTC) : null;
  const rState = stateOf(i.radar.status, rCheck);

  const live = i.optionsLive.status === "ok" ? i.optionsLive.doc : null;

  const s = i.snapshot.status === "ok" ? i.snapshot.snapshot : null;
  const sf = s ? freshness(s.as_of, list(s.expected_windows), nowMs) : null;
  const sState: FeedState =
    i.snapshot.status === "missing" ? "missing" : i.snapshot.status !== "ok" ? "error" : sf?.state === "late" || sf?.state === "stopped" || (sf?.ageMin ?? 0) > OFFLINE_HOURS * 60 ? "late" : sf?.state === "unknown" ? "missing" : "ok";

  return [
    {
      key: "journal",
      name: "Webull trades",
      href: "/trades",
      state: jState,
      asOf: j?.as_of ?? null,
      schedule: `Every 2 min in US market hours, then the evening sync at ${sydTime(jCheck?.nextDue ?? null)} Sydney`,
      note:
        jState === "late"
          ? "If Webull wants a sign-in approval in your app, the sync waits until you approve it."
          : j?.fills != null
            ? `${j.fills.toLocaleString("en-US")} fills on file`
            : undefined,
    },
    {
      key: "options",
      name: "Options levels",
      href: "/options",
      state: oState,
      asOf: o?.as_of ?? null,
      schedule: `After each close, ${sydTime(oCheck?.nextDue ?? null)} Sydney`,
      note: o
        ? oSession === "stale"
          ? `Levels are for ${weekDate(o.session)}, an earlier session`
          : `Levels for ${oSession === "today" ? "today" : "the next session"}, ${weekDate(o.session)}`
        : undefined,
      strip: i.optionsDates.length === 0 ? undefined : { dates: days, have: new Set(i.optionsDates), today, label: "Levels on file for each session" },
    },
    {
      key: "focus",
      name: "Top 4 focus card",
      href: "/options",
      state: fState,
      asOf: focus?.picked_at ?? null,
      schedule: "Picked after each close, with a heads-up before the open",
      note: focus
        ? pre
          ? <>Pre-open heads-up <RelativeTime iso={pre} fallback={sydney(pre)} /></>
          : "No pre-open heads-up yet for this session"
        : o
          ? "This levels edition has no focus card"
          : undefined,
    },
    {
      key: "radar",
      name: "Pre-market radar",
      href: "/radar",
      state: rState,
      asOf: r?.as_of ?? null,
      schedule: `Each weekday, sent ${sydTime(rCheck?.nextDue ?? null)} Sydney`,
      note: r ? `Edition for ${weekDate(r.edition_date)}` : undefined,
      strip: i.radarDates.length === 0 ? undefined : { dates: days, have: new Set(i.radarDates), today, label: "Radar editions on file for each day" },
    },
    {
      key: "options-live",
      name: "Options live data",
      href: "/options",
      state: i.optionsLive.status === "ok" ? "info" : i.optionsLive.status,
      asOf: live?.as_of ?? null,
      schedule: "Paper positions and open interest, from the host",
    },
    {
      key: "host",
      name: "Paper lab host",
      href: "#sla",
      state: sState,
      asOf: s?.as_of ?? null,
      schedule: "Every few minutes while the host's jobs run",
      note: sState === "ok" && sf?.state === "asleep" ? "Outside job hours: quiet is normal" : undefined,
    },
  ];
}

function Strip({ strip, todayDue }: { strip: NonNullable<Feed["strip"]>; todayDue: boolean }) {
  return (
    <div className="flex items-center gap-1" role="img" aria-label={strip.label}>
      {strip.dates.map((d) => {
        const have = strip.have.has(d);
        const pending = !have && d === strip.today && todayDue;
        const title = `${weekDate(d)}: ${have ? "on file" : pending ? "not yet" : "none (holiday or missed)"}`;
        return (
          <span
            key={d}
            title={title}
            className={cn(
              "h-3.5 flex-1 rounded-[2px]",
              have ? "bg-good-fill" : pending ? "border-border border border-dashed" : "bg-warn-fill/70",
            )}
          />
        );
      })}
    </div>
  );
}

export function FeedsPanel(input: FeedsInput) {
  const feeds = buildFeeds(input);
  const bad = feeds.filter((f) => f.state === "late" || f.state === "error").length;
  const nowMs = input.now.getTime();
  return (
    <Panel
      id="feeds"
      title="Your feeds"
      icon={Radio}
      means="What your trading pages are built from, and whether each one arrived on schedule. Times are Sydney. A US holiday can show a feed as late."
      action={<StatusBadge tone={bad === 0 ? "good" : "warn"}>{bad === 0 ? "All on schedule" : `${bad} need a look`}</StatusBadge>}
    >
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {feeds.map((f) => {
          const st = STATE[f.state];
          const ageMin = f.asOf ? Math.max(0, (nowMs - Date.parse(f.asOf)) / 60_000) : null;
          return (
            <li
              key={f.key}
              className={cn(
                "grid content-start gap-2 rounded-lg border p-3",
                f.state === "late" || f.state === "error" ? "border-warn/60 bg-warn-soft" : "border-border",
              )}
            >
              <div className="flex items-start gap-2">
                <Link href={f.href} className="flex-1 text-sm font-medium underline-offset-2 hover:underline">
                  {f.name}
                </Link>
                <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
              </div>
              <p className="text-2xl font-semibold tabular-nums">
                {f.asOf ? (
                  <RelativeTime iso={f.asOf} fallback={ageMin === null ? "—" : describeAge(ageMin)} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </p>
              <p className="text-muted-foreground text-xs">
                {f.asOf ? `Last published ${sydney(f.asOf)}. ` : ""}
                {f.schedule}.
              </p>
              {f.strip ? (
                <div className="grid gap-1">
                  <Strip strip={f.strip} todayDue={f.state !== "late"} />
                  <div className="text-muted-foreground flex justify-between text-[0.6875rem] tabular-nums">
                    <span>{shortDate(f.strip.dates[0])}</span>
                    <span>last 10 weekdays</span>
                    <span>{shortDate(f.strip.today)}</span>
                  </div>
                </div>
              ) : null}
              {f.note ? <p className="text-xs">{f.note}</p> : null}
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground mt-3 text-xs">
        The crypto harvest has its own page in{" "}
        <Link href="/crypto/operations" className="underline underline-offset-2">
          Crypto mode
        </Link>
        .
      </p>
    </Panel>
  );
}
