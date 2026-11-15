import { Bot, Gauge, ListOrdered, Radio, Wallet } from "lucide-react";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { StatTile, StatTiles } from "@/components/stat-tile";
import { Badge } from "@/components/ui/badge";
import { EnvFrame } from "@/components/ui/env-chip";
import { Money } from "@/components/ui/money";
import { Notice } from "@/components/ui/notice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fracPct, newYork, pct } from "@/lib/format";
import type { OptionsClone } from "@/lib/options-clone.types";
import type { OptionsCloneResult } from "@/lib/snapshot";
import { cn } from "@/lib/utils";

// "Options clone (paper)" on the Trades page: the paper bot that trades one same-day call or put at a time by the
// owner's rules (DEC-0030), in the Alpaca paper account. Everything here comes from its SAFE document: counts, ids,
// codes and statistics. It sits in a paper EnvFrame and its dollars are paper Money: never the owner's Webull money.

/** The panel's title; the Trades page's group heading and jump link say the same (trades-jump-bar.tsx). */
export const CLONE_TITLE = "Options clone (paper)";

const HYP_LABEL: Record<string, string> = { "HYP-0029": "HYP-0029", "HYP-0030": "HYP-0030", all: "Both", other: "Other" };
const VERDICT: Record<OptionsClone["setups"][number]["verdict"], { label: string; variant: "neutral" | "bad" | "good" }> = {
  none: { label: "Too early", variant: "neutral" },
  falsified: { label: "Falsified", variant: "bad" },
  passes: { label: "Passes", variant: "good" },
};

function signedFrac(v: number | null | undefined): string {
  return typeof v === "number" ? `${v > 0 ? "+" : ""}${fracPct(v)}` : "—";
}

function price(v: number | null | undefined): string {
  return typeof v === "number" ? v.toFixed(2) : "—";
}

function codes(m: Record<string, number | undefined>): string {
  const parts = Object.entries(m)
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(" · ") : "—";
}

export function ClonePanel({ result }: { result: OptionsCloneResult }) {
  const means =
    "The paper bot that buys one same-day call or put at a time by your nine rules (DEC-0030), with its own paper money. It never touches your account. Updated after every trade and at the close.";
  if (result.status !== "ok") {
    return (
      <EnvFrame env="paper" label="Options clone">
        <Panel id="clone" title={CLONE_TITLE} icon={Bot} means={means}>
          <Empty title={result.status === "missing" ? "No session from the clone yet" : "The clone's document could not be read"}>
            {result.status === "missing" ? "It appears here once the paper-o runner has armed for a session." : "Storage did not answer; the next update will try again."}
          </Empty>
        </Panel>
      </EnvFrame>
    );
  }
  return (
    <EnvFrame env="paper" label="Options clone">
      <Panel id="clone" title={CLONE_TITLE} icon={Bot} means={means}>
        <CloneBody d={result.doc} />
      </Panel>
    </EnvFrame>
  );
}

function CloneBody({ d }: { d: OptionsClone }) {
  const pnl = d.day_pnl.usd;
  const used = d.day_pnl.limit_usd > 0 && pnl < 0 ? Math.min(1, -pnl / d.day_pnl.limit_usd) : 0;
  return (
    <div className="grid gap-4" data-clone-session={d.session}>
      {d.flatten_required ? (
        <Notice tone="bad" size="sm" role="alert">
          Flatten required: the clone holds a position it cannot close itself. Close it by hand in the paper account; see the options clone runbook.
        </Notice>
      ) : null}
      {d.latch ? (
        <Notice tone="warn" size="sm" role="status">
          The {d.latch} loss latch is on: no new entries until it is reset after the close.
        </Notice>
      ) : null}
      {d.feed_unfit ? (
        <Notice tone="warn" size="sm" role="status">
          The option feed was unfit (quotes too old, or fills too far from the ask): no new entries for the rest of the session.
        </Notice>
      ) : null}
      <StatTiles>
        <StatTile
          label="Day result"
          icon={Wallet}
          tone={pnl > 0 ? "good" : pnl < 0 ? (used >= 0.75 ? "bad" : "warn") : "neutral"}
          value={<Money env="paper" value={pnl} />}
          hint={
            <>
              Limit <Money env="paper" value={-Math.abs(d.day_pnl.limit_usd)} />
              {pnl < 0 ? ` · ${Math.round(used * 100)}% used` : ""}
            </>
          }
        />
        <StatTile
          label="Entries"
          icon={ListOrdered}
          tone={d.entries.used >= d.entries.max ? "warn" : "neutral"}
          value={`${d.entries.used} of ${d.entries.max}`}
          hint={d.off.length ? `Entries off: ${d.off.join(", ")}` : "Entries on"}
        />
        <StatTile
          label="Names"
          icon={Radio}
          tone={d.names_source === "fallback" ? "warn" : "neutral"}
          value={d.names.length ? d.names.join(" ") : "—"}
          hint={d.names_source === "focus" ? "From the edition's focus" : d.names_source === "focus+top-up" ? "Focus names that trade today, plus SPY/QQQ" : d.names_source === "fallback" ? "Fallback: no focus for today" : undefined}
        />
        <StatTile
          label="Feed"
          icon={Gauge}
          tone={d.feed_unfit ? "bad" : "neutral"}
          value={typeof d.quote_age_median_s === "number" ? `${d.quote_age_median_s.toFixed(1)} s` : "—"}
          hint={`Quote age, median · slippage ${pct(d.slippage_median_pct)} · broker stop ${d.broker_stop ?? "not tried"}`}
        />
      </StatTiles>

      <section aria-labelledby="clone-trades" className="grid gap-1.5">
        <h3 id="clone-trades" className="text-sm font-medium">
          Trades this session
        </h3>
        {d.trades.length ? (
          <Table label="Trades this session">
            <TableHeader>
              <TableRow>
                <TableHead>Trade</TableHead>
                <TableHead>Hypothesis</TableHead>
                <TableHead>Contract</TableHead>
                <TableHead className="text-right">Fill → exit</TableHead>
                <TableHead>Exit</TableHead>
                <TableHead className="text-right">On premium</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.trades.map((t) => (
                <TableRow key={t.trade_id}>
                  <TableCell className="font-mono text-xs">{t.trade_id.slice(11)}</TableCell>
                  <TableCell>
                    {HYP_LABEL[t.hyp] ?? t.hyp} · {t.side}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{t.contract}</TableCell>
                  <TableCell className="text-right font-mono">
                    {price(t.fill)} → {price(t.exit_fill)}
                  </TableCell>
                  <TableCell>{t.exit_reason ?? (t.state === "closed" ? "—" : t.state)}</TableCell>
                  <TableCell className={cn("text-right font-mono", (t.rop ?? 0) > 0 ? "text-good" : (t.rop ?? 0) < 0 ? "text-bad" : "text-muted-foreground")}>
                    {signedFrac(t.rop)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-sm">No trade yet this session.</p>
        )}
      </section>

      <section aria-labelledby="clone-gates" className="grid gap-1.5">
        <h3 id="clone-gates" className="text-sm font-medium">
          Decisions by name
        </h3>
        {d.gates.length ? (
          <Table label="Decisions by name">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Bars</TableHead>
                <TableHead className="text-right">Setups</TableHead>
                <TableHead className="text-right">Entered</TableHead>
                <TableHead>Refused by gate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.gates.map((g) => (
                <TableRow key={g.symbol}>
                  <TableCell className="font-medium">{g.symbol}</TableCell>
                  <TableCell className="text-right font-mono">{g.bars}</TableCell>
                  <TableCell className="text-right font-mono">{g.setups}</TableCell>
                  <TableCell className="text-right font-mono">{g.entered}</TableCell>
                  <TableCell className="text-xs">{codes(g.refused_by)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-sm">No finished bar looked at yet.</p>
        )}
      </section>

      <section aria-labelledby="clone-setups" className="grid gap-1.5">
        <h3 id="clone-setups" className="text-sm font-medium">
          Every trade so far, by hypothesis
        </h3>
        <Table label="Every trade so far, by hypothesis">
          <TableHeader>
            <TableRow>
              <TableHead>Hypothesis</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">Won</TableHead>
              <TableHead className="text-right">Mean on premium</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Range by session</TableHead>
              <TableHead className="hidden text-right md:table-cell">Halves</TableHead>
              <TableHead>Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.setups.map((s) => (
              <TableRow key={s.hyp}>
                <TableCell className="font-medium">{HYP_LABEL[s.hyp] ?? s.hyp}</TableCell>
                <TableCell className="text-right font-mono">{s.trades}</TableCell>
                <TableCell className="text-right font-mono">{s.sessions}</TableCell>
                <TableCell className="text-right font-mono">{fracPct(s.win_rate)}</TableCell>
                <TableCell className="text-right font-mono">{signedFrac(s.mean_rop)}</TableCell>
                <TableCell className="hidden text-right font-mono sm:table-cell">
                  {s.ci_session ? `${signedFrac(s.ci_session[0])} to ${signedFrac(s.ci_session[1])}` : "—"}
                </TableCell>
                <TableCell className="hidden text-right font-mono md:table-cell">
                  {signedFrac(s.first_half_mean)} / {signedFrac(s.second_half_mean)}
                </TableCell>
                <TableCell>
                  <Badge variant={VERDICT[s.verdict].variant}>{VERDICT[s.verdict].label}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-muted-foreground text-xs">
          A verdict needs at least 30 trades over 20 sessions. It passes only when the range by session and both halves are above zero (DEC-0030, section 6).
        </p>
      </section>

      <p className="text-muted-foreground text-xs">
        Session {d.session}, {d.final ? "closed" : "in progress"}; updated {newYork(d.as_of)} New York time. Paper account only. Returns are on the premium paid, after fees.
      </p>
    </div>
  );
}
