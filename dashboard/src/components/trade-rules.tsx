// "Rules before every trade": the nine rules, colour-coded by what they guard, today's count against the day rules,
// and the evidence one click away. Server-rendered; the evidence opens with a native <details>, so it needs no script.
import {
  ChevronDown,
  CircleCheck,
  Crosshair,
  Lock,
  OctagonX,
  ScanEye,
  ShieldCheck,
  Square,
  TriangleAlert,
  UserCheck,
  Wallet,
} from "lucide-react";
import { DivergingBars } from "@/components/charts/diverging-bars";
import { sessionView, shortDay, type JournalDoc } from "@/lib/journal";
import {
  breakSummary,
  dayCheck,
  GROUPS,
  RULES,
  DAY_LOSS_LIMIT,
  MAX_TRADES_PER_DAY,
  money,
  PLAN_EXAMPLE,
  planNumbers,
  PRE_TRADE_CHECKS,
  ruleEvidence,
  type BreakSummary,
  type DayCheck,
  type Evidence,
  type RuleCheck,
  type RuleGroup,
} from "@/lib/trade-rules";
import { cn } from "@/lib/utils";

// Blue for where you enter, amber for what a trade may cost, red for when you stop.
const GROUP_STYLE: Record<
  RuleGroup,
  {
    edge: string;
    badge: string;
    text: string;
    soft: string;
    icon: typeof Crosshair;
  }
> = {
  setup: {
    edge: "border-t-info-fill",
    badge: "bg-info-fill text-white",
    text: "text-info",
    soft: "bg-info-soft",
    icon: Crosshair,
  },
  risk: {
    edge: "border-t-warn-fill",
    badge: "bg-warn-fill text-black",
    text: "text-warn",
    soft: "bg-warn-soft",
    icon: Wallet,
  },
  day: {
    edge: "border-t-bad-fill",
    badge: "bg-bad-fill text-white",
    text: "text-bad",
    soft: "bg-bad-soft",
    icon: OctagonX,
  },
};

// Who holds each rule. Nothing here can block an order in Webull; the icons say so rule by rule.
const CHECK: Record<RuleCheck, { icon: typeof Lock; word: string }> = {
  you: { icon: UserCheck, word: "You check this before the order" },
  flagged: { icon: ScanEye, word: "The journal flags a break after the trade" },
  broker: { icon: Lock, word: "A Webull stop order can hold this for you" },
};

const STATUS = {
  clear: {
    word: "Clear to trade",
    icon: CircleCheck,
    text: "text-good",
    soft: "bg-good-soft border-good-fill/40",
    fill: "bg-good-fill",
  },
  careful: {
    word: "Careful",
    icon: TriangleAlert,
    text: "text-warn",
    soft: "bg-warn-soft border-warn-fill/50",
    fill: "bg-warn-fill",
  },
  stop: {
    word: "Stop for today",
    icon: OctagonX,
    text: "text-bad",
    soft: "bg-bad-soft border-bad-fill/50",
    fill: "bg-bad-fill",
  },
} as const;

function DayMeter({
  label,
  used,
  max,
  text,
  fill,
}: {
  label: string;
  used: number;
  max: number;
  text: string;
  fill: string;
}) {
  const share = Math.min(1, Math.max(0, used / max));
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-semibold">{text}</span>
      </div>
      <div
        className="bg-track/70 h-2 overflow-hidden rounded-full"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(max, used)}
        aria-valuetext={text}
      >
        <div
          className={cn("h-full rounded-full", fill)}
          style={{ width: `${Math.max(share > 0 ? 4 : 0, share * 100)}%` }}
        />
      </div>
    </div>
  );
}

function TodayStrip({ check }: { check: DayCheck }) {
  const s = STATUS[check.status];
  const lossUsed = Math.max(0, -check.net);
  const tradesFill =
    check.used >= MAX_TRADES_PER_DAY
      ? "bg-bad-fill"
      : check.used >= MAX_TRADES_PER_DAY - 1
        ? "bg-warn-fill"
        : "bg-good-fill";
  const lossFill =
    lossUsed >= DAY_LOSS_LIMIT
      ? "bg-bad-fill"
      : lossUsed >= DAY_LOSS_LIMIT * 0.6
        ? "bg-warn-fill"
        : "bg-good-fill";
  return (
    <div
      className={cn(
        "grid items-center gap-3 rounded-lg border px-3.5 py-3 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto]",
        s.soft,
      )}
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2.5 sm:pr-2">
        <s.icon aria-hidden className={cn("size-6 shrink-0", s.text)} />
        <div className="grid min-w-0 leading-tight">
          <span className={cn("text-sm font-semibold", s.text)}>
            {check.isToday ? s.word : "New day"}
          </span>
          <span className="text-muted-foreground text-xs">{check.line}</span>
        </div>
      </div>
      <DayMeter
        label="Trades today"
        used={check.used}
        max={MAX_TRADES_PER_DAY}
        text={`${check.used} of ${MAX_TRADES_PER_DAY}`}
        fill={tradesFill}
      />
      <DayMeter
        label="Day loss limit"
        used={lossUsed}
        max={DAY_LOSS_LIMIT}
        text={`${check.net < 0 ? money(check.net) : check.net > 0 ? money(check.net) : "$0"} of −$${DAY_LOSS_LIMIT}`}
        fill={lossFill}
      />
      <div className="flex items-baseline justify-between gap-2 text-xs sm:grid sm:justify-items-end sm:gap-0.5">
        <span className="text-muted-foreground">Rule breaks today</span>
        <span
          className={cn(
            "font-mono text-sm font-semibold",
            check.brokenRules.length ? "text-bad" : "text-good",
          )}
        >
          {check.brokenRules.length
            ? `${check.brokenRules.length > 1 ? "Rules" : "Rule"} ${check.brokenRules.join(", ")}`
            : "None"}
        </span>
      </div>
    </div>
  );
}

const fmtCompare = (unit: string) => (v: number) =>
  money(v) + (unit === "average per day" ? "/day" : "");

function EvidenceRow({
  n,
  title,
  group,
  ev,
}: {
  n: number;
  title: string;
  group: RuleGroup;
  ev: Evidence | undefined;
}) {
  const g = GROUP_STYLE[group];
  return (
    <li className="grid gap-2 py-3 not-last:border-b sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-6">
      <div className="grid content-start gap-1">
        <p className="flex items-start gap-2 text-sm leading-snug font-semibold">
          <span
            className={cn(
              "mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[0.6875rem]",
              g.badge,
            )}
          >
            {n}
          </span>
          {title}
        </p>
        {ev ? (
          <p className="text-muted-foreground text-[0.8125rem] leading-snug">
            <span
              className={cn(
                "mr-1.5 rounded px-1 py-px text-[0.625rem] font-semibold tracking-wide uppercase",
                ev.source === "yours"
                  ? "bg-info-soft text-info"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {ev.source === "yours" ? "Your trades" : "Backtest"}
            </span>
            {ev.finding}
          </p>
        ) : (
          <p className="text-muted-foreground text-[0.8125rem]">
            Not enough trades yet to measure this one.
          </p>
        )}
      </div>
      {ev?.compare ? (
        <div className="self-center">
          <DivergingBars
            label={`${title}: ${ev.compare.a.label} against ${ev.compare.b.label}, ${ev.compare.unit}`}
            better="positive"
            format={fmtCompare(ev.compare.unit)}
            rows={[
              {
                key: "a",
                label: ev.compare.a.label,
                value: ev.compare.a.value,
              },
              {
                key: "b",
                label: ev.compare.b.label,
                value: ev.compare.b.value,
              },
            ]}
          />
          <p className="text-muted-foreground mt-1 text-[0.6875rem]">
            {ev.compare.unit[0]!.toUpperCase() + ev.compare.unit.slice(1)},
            before fees
          </p>
        </div>
      ) : null}
    </li>
  );
}

function CheckIcon({ check }: { check: RuleCheck }) {
  const c = CHECK[check];
  return (
    <span
      className="text-muted-foreground mt-0.5 ml-auto shrink-0"
      title={c.word}
    >
      <c.icon aria-hidden className="size-3.5" />
      <span className="sr-only">{c.word}</span>
    </span>
  );
}

const usd = (v: number) => `$${v.toFixed(v % 1 ? 2 : 0)}`;

/** The checklist to tick before every order, beside a plan worked out in dollars. */
function BeforeYouBuy() {
  const p = planNumbers(
    PLAN_EXAMPLE.premium,
    PLAN_EXAMPLE.stopShare,
    PLAN_EXAMPLE.targetShare,
  );
  const rows: [string, string][] = [
    ["Premium", usd(PLAN_EXAMPLE.premium)],
    [
      `Planned loss (${Math.round(PLAN_EXAMPLE.stopShare * 100)}%)`,
      usd(p.risk),
    ],
    [`Target (${Math.round(PLAN_EXAMPLE.targetShare * 100)}%)`, usd(p.reward)],
    ["Reward to risk", `${p.ratio.toFixed(p.ratio % 1 ? 1 : 0)} : 1`],
  ];
  return (
    <section
      aria-labelledby="before-buy"
      className="grid gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-6"
    >
      <div className="grid content-start gap-2">
        <h3
          id="before-buy"
          className="text-[0.6875rem] font-semibold tracking-wide uppercase"
        >
          Before you press buy
        </h3>
        <ul className="grid gap-1.5 sm:grid-cols-2 sm:gap-x-4">
          {PRE_TRADE_CHECKS.map((c) => (
            <li key={c} className="flex items-start gap-2 text-xs leading-snug">
              <Square
                aria-hidden
                className="text-muted-foreground mt-px size-3.5 shrink-0"
              />
              {c}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid content-start gap-1.5">
        <p className="text-[0.6875rem] font-semibold tracking-wide uppercase">
          The plan in dollars, written first
        </p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right font-mono font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground text-[0.6875rem] leading-snug">
          Example. The real stop is where the chart proves you wrong, never past
          −25%. Before fees and slippage.
        </p>
      </div>
    </section>
  );
}

/** Rule breaks over recent sessions, kept apart from losing trades. */
function BreakRow({ s }: { s: BreakSummary }) {
  const chips = RULES.filter((r) => s.byRule[r.id]);
  return (
    <section
      aria-label={`Rule breaks, last ${s.sessions} sessions`}
      className="grid gap-2 rounded-lg border px-3 py-2.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-x-5"
    >
      <p className="font-semibold">
        Rule breaks, last {s.sessions} sessions:{" "}
        <span className={cn("font-mono", s.trades ? "text-bad" : "text-good")}>
          {s.trades ? `${s.trades} trade${s.trades === 1 ? "" : "s"}` : "none"}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {chips.length ? (
          <span className="flex flex-wrap gap-1">
            {chips.map((r) => {
              const g = GROUP_STYLE[r.group];
              return (
                <span
                  key={r.id}
                  className={cn(
                    "rounded px-1.5 py-px font-mono",
                    g.soft,
                    g.text,
                  )}
                  title={r.title}
                >
                  <span className="sr-only">Rule </span>#{r.n} ×{s.byRule[r.id]}
                </span>
              );
            })}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          Rules broken{" "}
          <span className="text-foreground font-mono font-semibold">
            {money(s.brokeNet)}
          </span>{" "}
          · rules kept{" "}
          <span className="text-foreground font-mono font-semibold">
            {money(s.keptNet)}
          </span>
          {s.keptLosers
            ? `, including ${s.keptLosers} loss${s.keptLosers === 1 ? "" : "es"} that followed the plan (${money(s.keptLosersNet)})`
            : null}
        </span>
      </div>
    </section>
  );
}

/**
 * The rules panel. `check` is today's count against the day rules (left out where the page has no journal);
 * `evidence` is measured from the owner's trades and the levels backtests; `tradeCount` says how many trades it covers.
 */
export function TradeRules({
  check,
  evidence,
  tradeCount,
  since,
  breaks = null,
}: {
  check: DayCheck | null;
  evidence: Record<string, Evidence>;
  tradeCount: number;
  since: string | null;
  breaks?: BreakSummary | null;
}) {
  return (
    <section
      id="rules"
      aria-labelledby="rules-title"
      className="bg-card relative overflow-hidden rounded-xl border shadow-sm before:absolute before:inset-x-0 before:top-0 before:h-1 before:bg-[linear-gradient(90deg,var(--info-fill),var(--warn-fill),var(--bad-fill))]"
    >
      <div className="grid gap-4 p-4 sm:p-5">
        <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="grid gap-0.5">
            <h2
              id="rules-title"
              className="flex items-center gap-2 text-base font-semibold tracking-tight"
            >
              <ShieldCheck aria-hidden className="text-good size-5" />
              Rules before every trade
            </h2>
            <p className="text-muted-foreground text-xs">
              Support and resistance at the previous day, week and month highs
              and lows, breakout and retest. Protect the downside first.
            </p>
          </div>
        </header>

        {check ? <TodayStrip check={check} /> : null}

        <ol className="grid gap-3 md:grid-cols-3" aria-label="The nine rules">
          {GROUPS.map((group) => {
            const g = GROUP_STYLE[group.id];
            return (
              <li
                key={group.id}
                className={cn(
                  "bg-background/40 grid content-start gap-2.5 rounded-lg border border-t-4 p-3",
                  g.edge,
                )}
              >
                <p
                  className={cn(
                    "flex items-center gap-1.5 text-[0.6875rem] font-semibold tracking-wide uppercase",
                    g.text,
                  )}
                >
                  <g.icon aria-hidden className="size-3.5" />
                  {group.title}
                  <span className="text-muted-foreground font-normal normal-case tracking-normal">
                    · {group.means}
                  </span>
                </p>
                <ol className="grid gap-2.5">
                  {RULES.filter((r) => r.group === group.id).map((r) => (
                    <li key={r.id} className="flex items-start gap-2.5">
                      <span
                        className={cn(
                          "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-bold",
                          g.badge,
                        )}
                        aria-hidden
                      >
                        {r.n}
                      </span>
                      <span className="grid min-w-0 gap-0.5 leading-snug">
                        <span className="text-[0.875rem] font-semibold">
                          <span className="sr-only">Rule {r.n}: </span>
                          {r.title}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {r.detail}
                        </span>
                      </span>
                      <CheckIcon check={r.check} />
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>

        <p className="text-muted-foreground -mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem]">
          {(Object.keys(CHECK) as RuleCheck[]).map((k) => {
            const c = CHECK[k];
            return (
              <span key={k} className="inline-flex items-center gap-1">
                <c.icon aria-hidden className="size-3.5" />
                {c.word}
              </span>
            );
          })}
          <span>Nothing on this page can block an order.</span>
        </p>

        <BeforeYouBuy />

        {breaks && breaks.sessions > 0 ? <BreakRow s={breaks} /> : null}

        <details className="group rounded-lg border">
          <summary className="hover:bg-muted/50 flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span>
              Why each rule: the evidence
              <span className="text-muted-foreground font-normal">
                {tradeCount > 0
                  ? ` from your ${tradeCount.toLocaleString("en-US")} closed trades${since ? ` since ${since}` : ""} and the levels backtests`
                  : " from the levels backtests"}
              </span>
            </span>
            <ChevronDown
              aria-hidden
              className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="border-t px-3.5 pb-1">
            <ol className="grid">
              {RULES.map((r) => (
                <EvidenceRow
                  key={r.id}
                  n={r.n}
                  title={r.title}
                  group={r.group}
                  ev={evidence[r.id]}
                />
              ))}
            </ol>
            <p className="text-muted-foreground border-t py-3 text-xs">
              Your numbers are measured from the broker&apos;s history every
              time this page loads, matched first in, first out and before fees.
              They describe what happened and do not predict anything. The
              backtest numbers are stock moves in units of risk, before option
              costs.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}

/** The panel for a page that has the journal (or not): today's check and the evidence come from it. */
export function TradeRulesFor({
  doc,
  now,
}: {
  doc: JournalDoc | null;
  now: Date;
}) {
  const trades = doc?.trades ?? [];
  const first = trades.reduce<string | null>(
    (m, t) => (m === null || t.opened_at < m ? t.opened_at : m),
    null,
  );
  return (
    <TradeRules
      check={doc ? dayCheck(sessionView(doc, now)) : null}
      evidence={ruleEvidence(trades)}
      breaks={trades.length ? breakSummary(trades) : null}
      tradeCount={trades.length}
      since={first ? shortDay(first.slice(0, 10)) : null}
    />
  );
}
