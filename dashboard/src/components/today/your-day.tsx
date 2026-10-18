// The Today page's top: the owner's own trading day from the Webull journal, drawn on the New York clock.
import { Activity } from "lucide-react";
import Link from "next/link";
import { Meter } from "@/components/overview/home";
import { Panel } from "@/components/panel";
import { StatusBadge, TONE_TEXT } from "@/components/status";
import { TradeClock } from "@/components/today/trade-clock";
import { contractLabel, fmtMinutes, holdMinutes, marketState, nyTime, sessionView, type JournalDoc } from "@/lib/journal";
import type { Tone } from "@/lib/labels";
import { dayClock } from "@/lib/overview";
import { DAY_LOSS_LIMIT, MAX_TRADES_PER_DAY, TIME_STOP_MINUTES, dayCheck } from "@/lib/trade-rules";
import { cn } from "@/lib/utils";

const usd = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  // The word joiner keeps the sign on the same line as the amount.
  return `${v > 0 ? "+⁠" : v < 0 ? "−⁠" : ""}$${s}`;
};
const toneOf = (v: number | null | undefined): Tone => (v === null || v === undefined || v === 0 ? "neutral" : v > 0 ? "good" : "bad");
const nyClock = new Intl.DateTimeFormat("en-AU", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" });
const RULE: Record<"clear" | "careful" | "stop", { tone: Tone; word: string }> = {
  clear: { tone: "good", word: "OK to trade" },
  careful: { tone: "warn", word: "Careful" },
  stop: { tone: "bad", word: "Stop for today" },
};

export function YourDay({ doc, now }: { doc: JournalDoc; now: Date }) {
  const view = sessionView(doc, now);
  if (!view) return null;
  const check = dayCheck(view);
  const market = marketState(now);
  const nowMinute = view.isToday ? nyTime(now.toISOString()).minute : null;
  const clock = dayClock(view.trades, view.isToday ? view.open : [], view.day, nowMinute, contractLabel);
  const s = view.summary;
  const lossUsed = Math.max(0, -check.net);
  const slow = view.trades.filter((t) => holdMinutes(t) > TIME_STOP_MINUTES);
  const slowPnl = slow.reduce((a, t) => a + t.pnl, 0);
  const rule = RULE[check.status];
  const title = `${view.isToday ? "Your day" : "Your last session"} · ${dayFmt.format(new Date(`${view.day}T12:00:00Z`)).replace(",", "")}`;
  return (
    <Panel
      id="your-day"
      title={title}
      icon={Activity}
      means="Your own Webull trades for the New York day, read from the broker every two minutes while the market is open. Each bar is one trade from entry to exit; the line under them is the day's running result."
      action={<StatusBadge tone={view.isToday ? rule.tone : "neutral"}>{view.isToday ? rule.word : market === "closed" ? "Market closed" : "No trades yet today"}</StatusBadge>}
    >
      <div className="grid gap-5">
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
          <div className="grid content-start gap-1">
            <p className="text-muted-foreground text-xs">Day result</p>
            <p className={cn("font-mono text-3xl font-semibold tracking-tight", TONE_TEXT[toneOf(s.trades ? s.net : null)])}>{s.trades ? usd(s.net) : "$0"}</p>
            <p className="text-muted-foreground text-xs">
              {s.trades ? `${s.trades} closed · ${s.wins} won · ${s.losses} lost` : "Nothing closed yet"}
              {view.open.length ? ` · ${view.open.length} open` : ""}
            </p>
          </div>
          <div className="grid content-start gap-1">
            <p className="text-muted-foreground text-xs">Best and worst</p>
            <p className="font-mono text-base font-semibold">
              <span className="text-good">{s.best && s.best.pnl > 0 ? usd(s.best.pnl) : "—"}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-bad">{s.worst && s.worst.pnl < 0 ? usd(s.worst.pnl) : "—"}</span>
            </p>
            <p className="text-muted-foreground text-xs">
              {slow.length ? `${slow.length} held over ${TIME_STOP_MINUTES} min: ${usd(slowPnl)}` : `Every exit inside ${TIME_STOP_MINUTES} min`}
            </p>
          </div>
          <Meter
            label="Trades today"
            text={`${check.used} of ${MAX_TRADES_PER_DAY}`}
            share={check.used / MAX_TRADES_PER_DAY}
            tone={check.used >= MAX_TRADES_PER_DAY ? "bad" : check.used >= MAX_TRADES_PER_DAY - 1 ? "warn" : "good"}
          />
          <Meter
            label="Day loss used"
            text={`${lossUsed ? `−$${Math.round(lossUsed)}` : "$0"} of −$${DAY_LOSS_LIMIT}`}
            share={lossUsed / DAY_LOSS_LIMIT}
            tone={lossUsed >= DAY_LOSS_LIMIT ? "bad" : lossUsed >= DAY_LOSS_LIMIT * 0.6 ? "warn" : "good"}
          />
        </div>
        <p className={cn("text-sm", TONE_TEXT[view.isToday ? rule.tone : "neutral"])}>{check.line}</p>
        {clock.items.length ? <TradeClock items={clock.items} lanes={clock.lanes} steps={clock.steps} nowMinute={nowMinute} day={view.day} /> : null}
        {view.trades.length ? (
          <ul className="grid sm:grid-cols-2 sm:gap-x-6" aria-label="Trades closed this session, newest first">
            {view.trades.slice(0, 10).map((t) => (
              <li key={t.id} className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-1.5 text-[0.8125rem]">
                <span className="text-muted-foreground font-mono text-xs">{nyClock.format(new Date(t.closed_at))}</span>
                <span className="grid min-w-0 leading-tight">
                  <span className="truncate font-medium">{contractLabel(t)}</span>
                  <span className="text-muted-foreground truncate text-xs">{t.close === "expired" ? "held to expiry" : `held ${fmtMinutes(holdMinutes(t))}`}</span>
                </span>
                <span className={cn("font-mono font-semibold whitespace-nowrap", TONE_TEXT[toneOf(t.pnl)])}>{usd(t.pnl)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted-foreground text-xs">
          Times are New York, results in US dollars before fees.{" "}
          <Link href="/trades#today" className="underline underline-offset-2">
            Every trade and the patterns on Trades
          </Link>
        </p>
      </div>
    </Panel>
  );
}
