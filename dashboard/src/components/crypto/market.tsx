import { Activity, BarChart3, Compass, Grid3x3, ListOrdered, PieChart } from "lucide-react";
import { Columns } from "@/components/charts/columns";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { StatTile } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { moneyOf, plural, type Crypto } from "@/lib/crypto";
import { fracPct, num, pct, rMult, signed, zoned } from "@/lib/format";
import { coinRows, correlationGrid, exposureMap, priceDigits, regimeOf, shade, sleeveResults, trendOf } from "@/lib/market";
import { cn } from "@/lib/utils";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const toneOf = (v: number | null | undefined) => (!isNum(v) || Math.abs(v) < 0.005 ? "text-foreground" : v > 0 ? "text-good" : "text-bad");
const utc = (iso: string | null) => (iso ? `${zoned(iso, "UTC")} UTC` : null);
const NOT_A_SIGNAL = "It describes the market; no rule, limit or model on the desk reads it.";

/** The market the coins share, in six readings. */
export function RegimePanel({ s }: { s: Crypto }) {
  const r = regimeOf(s);
  const money = moneyOf(s);
  const grid = correlationGrid(s);
  return (
    <Panel
      title="Market state"
      icon={Compass}
      means={`Three things the desk's rules already look at, read for the whole market: Bitcoin against its 50-day average, how many traded coins are above their own 50-bar average, and how much Bitcoin has been moving. "Rising" means Bitcoin is above its average and at least half the coins are above theirs; "Falling" means neither. ${NOT_A_SIGNAL}`}
      action={<StatusBadge tone={r.tone}>{r.label}</StatusBadge>}
    >
      {!r.available ? (
        <Empty title="The host has not published the market monitor yet">It appears after the first bar cycle on a build that carries it.</Empty>
      ) : (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatTile
              label="Bitcoin vs 50-day average"
              value={isNum(r.btcVsSma50Pct) ? `${signed(r.btcVsSma50Pct, 2)}%` : "—"}
              tone={!isNum(r.btcVsSma50Pct) ? "neutral" : r.btcVsSma50Pct > 0 ? "good" : "bad"}
              hint={isNum(r.btcClose) && isNum(r.btcSma50) ? `${money(r.btcClose, 0)} against ${money(r.btcSma50, 0)}` : "Needs 50 daily bars"}
            />
            <StatTile
              label="Bitcoin over 30 days"
              value={isNum(r.btcRet30d) ? `${signed(r.btcRet30d, 2)}%` : "—"}
              tone={!isNum(r.btcRet30d) ? "neutral" : r.btcRet30d > 0 ? "good" : "bad"}
              hint="Last daily close against the one 30 days before"
            />
            <StatTile
              label="Bitcoin volatility"
              value={isNum(r.vol30dPct) ? `${num(r.vol30dPct, 1)}%` : "—"}
              hint="Its daily moves over 30 days, as a yearly figure"
            />
            <StatTile
              label="Above 50-bar average"
              value={isNum(r.aboveEma50) ? `${num(r.aboveEma50)} of ${num(r.pairs)}` : "—"}
              tone={!isNum(r.breadth) ? "neutral" : r.breadth >= 0.5 ? "good" : "bad"}
              hint={isNum(r.breadth) ? `${fracPct(r.breadth, 0)} of the traded coins` : "No coin has 50 bars yet"}
            />
            <StatTile
              label="Coins up over 30 bars"
              value={isNum(r.rising) ? `${num(r.rising)} of ${num(r.pairs)}` : "—"}
              hint="Five days of 4-hour bars"
            />
            <StatTile
              label="Average correlation"
              value={isNum(grid?.mean) ? num(grid.mean, 2) : "—"}
              tone={!isNum(grid?.mean) ? "neutral" : grid.mean >= 0.7 ? "warn" : "info"}
              hint="Between each two coins; near 1, they are one bet"
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {[r.bar ? `Newest 4-hour bar closed ${utc(r.bar)}` : null, r.dailyBar ? `newest daily bar ${utc(r.dailyBar)}` : null].filter(Boolean).join(" · ")}
            {r.stale ? " · the daily bars are behind: these readings describe an older market" : ""}
          </p>
        </div>
      )}
    </Panel>
  );
}

/** Every traded coin on its newest closed bar, strongest first, with what each rule made of it. */
export function OpportunityPanel({ s }: { s: Crypto }) {
  const rows = coinRows(s);
  const money = moneyOf(s);
  const firing = rows.filter((r) => r.rules.some((x) => x.fires)).length;
  return (
    <Panel
      title="Coins, strongest first"
      icon={ListOrdered}
      means={`Each traded coin on its newest closed 4-hour bar, ordered by its return over 30 bars: the one measure the desk has fixed for ordering coins (DEC-0025). "To the high" is the close against the highest price of the bars before it: zero or above is a new high, which is what the trend and breakout rules wait for. The last columns say what each registered rule made of the coin and which paper books hold it. ${NOT_A_SIGNAL}`}
      action={rows.length > 0 ? <StatusBadge tone={firing > 0 ? "info" : "neutral"}>{firing > 0 ? `${plural(firing, "coin")} with a rule firing` : "No rule firing"}</StatusBadge> : undefined}
    >
      {rows.length === 0 ? (
        <Empty title="No coin has a stored bar yet" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Coin</TableHead>
                <TableHead className="text-right">Close</TableHead>
                <TableHead className="text-right">1 day</TableHead>
                <TableHead className="text-right">30 bars</TableHead>
                <TableHead className="text-right">To 20-bar high</TableHead>
                <TableHead className="text-right">To 30-bar high</TableHead>
                <TableHead>Trend</TableHead>
                <TableHead className="text-right">RSI</TableHead>
                <TableHead className="text-right">Range (ATR)</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead>Rules</TableHead>
                <TableHead>Held by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const trend = trendOf(r);
                return (
                  <TableRow key={r.pair}>
                    <TableCell className="text-muted-foreground font-mono text-xs">{r.rank ?? "—"}</TableCell>
                    <TableCell className="font-medium">
                      {r.coin}
                      {r.stale ? <span className="text-warn ml-1.5 text-xs font-normal">bars behind</span> : null}
                    </TableCell>
                    <TableCell className="text-right font-mono">{money(r.close, priceDigits(r.close))}</TableCell>
                    <TableCell className={cn("text-right font-mono", toneOf(r.retDay))}>{isNum(r.retDay) ? `${signed(r.retDay, 2)}%` : "—"}</TableCell>
                    <TableCell className={cn("text-right font-mono font-medium", toneOf(r.ret30))}>{isNum(r.ret30) ? `${signed(r.ret30, 2)}%` : "—"}</TableCell>
                    <HighCell v={r.toHigh20} />
                    <HighCell v={r.toHigh30} />
                    <TableCell>
                      <StatusBadge tone={trend.tone}>{trend.label}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{isNum(r.rsi) ? num(r.rsi, 0) : "—"}</TableCell>
                    <TableCell className="text-right font-mono">{isNum(r.atrPct) ? pct(r.atrPct, 2) : "—"}</TableCell>
                    <TableCell className="text-right font-mono">{isNum(r.volumeRatio) ? `${num(r.volumeRatio, 2)}×` : "—"}</TableCell>
                    <TableCell>
                      {r.rules.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                          {r.rules.map((x) => (
                            <li key={x.sleeve} className={x.fires ? "text-info font-medium" : "text-muted-foreground"}>
                              {`${x.label}: ${x.fires ? "fires" : x.unmet > 0 ? `${x.unmet} unmet` : "no"}`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{r.heldBy.length > 0 ? r.heldBy.join(", ") : <span className="text-muted-foreground">—</span>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

function HighCell({ v }: { v: number | null }) {
  const made = isNum(v) && v >= 0;
  return (
    <TableCell className={cn("text-right font-mono", made ? "text-info font-medium" : "text-foreground")}>
      {isNum(v) ? (made ? `new high ${signed(v, 2)}%` : `${signed(v, 2)}%`) : "—"}
    </TableCell>
  );
}

/** How the coins moved together: a square of numbers, shaded by how near each is to one. */
export function CorrelationPanel({ s }: { s: Crypto }) {
  const g = correlationGrid(s);
  return (
    <Panel
      title="How the coins move together"
      icon={Grid3x3}
      means={`The correlation of each two coins' 4-hour returns over the newest ${g?.bars ?? 120} bars: 1 means they rose and fell together bar for bar, 0 that they had nothing to do with each other, below 0 that one rose when the other fell. Coins near 1 are one bet held several times, which is why the desk caps the risk open across its books together. A cell is blank when the two coins share too few bars. ${NOT_A_SIGNAL}`}
    >
      {!g ? (
        <Empty title="Not enough bars yet">Correlation needs at least two coins with 30 bars in common.</Empty>
      ) : (
        <div className="grid gap-3">
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0.5 text-center font-mono text-xs" aria-label="Correlation of each two coins' 4-hour returns">
              <thead>
                <tr>
                  <td />
                  {g.coins.map((c) => (
                    <th key={c} scope="col" className="text-muted-foreground px-1 py-1 font-sans font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {g.coins.map((row, i) => (
                  <tr key={row}>
                    <th scope="row" className="text-muted-foreground pr-2 text-left font-sans font-medium">
                      {row}
                    </th>
                    {g.coins.map((col, j) => {
                      const v = g.cells[i]?.[j] ?? null;
                      const sh = shade(i === j ? null : v);
                      return (
                        <td
                          key={col}
                          className={cn("min-w-10 rounded-[3px] px-1 py-1.5", i === j ? "text-muted-foreground bg-muted" : "text-foreground")}
                          style={sh.side === "none" ? undefined : { backgroundColor: `color-mix(in srgb, var(${sh.side === "with" ? "--chart-1" : "--bad-fill"}) ${Math.round(sh.strength * 55)}%, transparent)` }}
                        >
                          {i === j ? "1" : isNum(v) ? num(v, 2) : ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">Average between two coins</dt>
              <dd className="font-mono font-medium">{isNum(g.mean) ? num(g.mean, 2) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Moved together most</dt>
              <dd className="font-mono font-medium">{g.tightest ? `${g.tightest.a} and ${g.tightest.b} ${num(g.tightest.value, 2)}` : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Moved together least</dt>
              <dd className="font-mono font-medium">{g.loosest ? `${g.loosest.a} and ${g.loosest.b} ${num(g.loosest.value, 2)}` : "—"}</dd>
            </div>
          </dl>
        </div>
      )}
    </Panel>
  );
}

/** What the tournament's books hold between them, by coin and by book. */
export function ExposurePanel({ s }: { s: Crypto }) {
  const e = exposureMap(s);
  const money = moneyOf(s);
  return (
    <Panel
      title="What the books hold"
      icon={PieChart}
      means="The open positions of the tournament's paper books added up by coin and by book, at the last price the host read. 'At the stops' is what would be lost if every stop were hit at its price. The books are separate and never pooled; this shows how concentrated they are together. The baseline book is outside it. Paper money."
      action={e.available ? <StatusBadge tone={e.coins.length > 0 ? "info" : "neutral"}>{e.coins.length > 0 ? `${plural(e.coins.length, "coin")} held` : "Nothing held"}</StatusBadge> : undefined}
    >
      {!e.available ? (
        <Empty title="The host has not published the books' holdings yet" />
      ) : (
        <div className="grid gap-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Figure label="Equity of the books" value={money(e.equity)} />
            <Figure label="Held in coins" value={money(e.gross)} hint={isNum(e.grossPct) ? `${pct(e.grossPct, 1)} of equity` : undefined} />
            <Figure label="At the stops" value={money(e.risk)} hint={isNum(e.riskPct) ? `${pct(e.riskPct, 2)} of equity` : undefined} />
            <Figure label="Largest coin" value={isNum(e.largestSharePct) ? pct(e.largestSharePct, 0) : "—"} hint={e.coins[0] ? `${e.coins[0].coin}, of what is held` : undefined} />
          </dl>
          {e.coins.length === 0 ? (
            <p className="text-muted-foreground text-sm">No book holds a position now.</p>
          ) : (
            <ul className="grid gap-2" aria-label="Holdings by coin, largest first">
              {e.coins.map((c) => (
                <li key={c.pair} className="grid gap-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                    <span className="font-medium">
                      {c.coin} <span className="text-muted-foreground text-xs font-normal">{c.books.join(", ")}</span>
                    </span>
                    <span className="font-mono text-xs">
                      {money(c.notional)} · {pct(c.sharePct, 0)} of holdings{isNum(c.equityPct) ? ` · ${pct(c.equityPct, 1)} of equity` : ""}
                      {isNum(c.risk) ? ` · ${money(c.risk)} at the stop` : ""}
                      {isNum(c.unrealised) ? <span className={toneOf(c.unrealised)}> · open {signed(c.unrealised, 2)}</span> : null}
                    </span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div className="bg-info-fill h-full rounded-full" style={{ width: `${c.sharePct}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Book</TableHead>
                  <TableHead className="text-right">Equity</TableHead>
                  <TableHead className="text-right">Positions</TableHead>
                  <TableHead className="text-right">Held in coins</TableHead>
                  <TableHead className="text-right">Of its equity</TableHead>
                  <TableHead className="text-right">At the stops</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {e.books.map((b) => (
                  <TableRow key={b.name}>
                    <TableCell className="font-medium">{b.label}</TableCell>
                    <TableCell className="text-right font-mono">{money(b.equity)}</TableCell>
                    <TableCell className="text-right font-mono">{num(b.positions)}</TableCell>
                    <TableCell className="text-right font-mono">{money(b.notional)}</TableCell>
                    <TableCell className="text-right font-mono">{isNum(b.notionalPct) ? pct(b.notionalPct, 1) : "—"}</TableCell>
                    <TableCell className="text-right font-mono">{isNum(b.riskPct) ? `${money(b.risk)} · ${pct(b.riskPct, 2)}` : money(b.risk)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground truncate text-xs">{label}</dt>
      <dd className="font-mono text-sm font-medium">{value}</dd>
      {hint ? <dd className="text-muted-foreground text-xs">{hint}</dd> : null}
    </div>
  );
}

/** Every closed trade of each sleeve by its result in R, with what a win and a loss are worth. */
export function RDistributionPanel({ s }: { s: Crypto }) {
  const all = sleeveResults(s);
  return (
    <Panel
      title="Results by size, in R"
      icon={BarChart3}
      means="Every closed paper trade of each sleeve, counted by its result in R (1R is what the trade risked at its stop when it opened), fees included. Each column starts at the value under it: '−1' holds results from −1R up to −0.5R. A sleeve makes money only if its win rate is above the break-even rate its own wins and losses set. Paper trades in incubation: none of this is evidence of an edge."
    >
      {all.length === 0 ? (
        <Empty title="No sleeve has closed a trade yet" icon={Activity} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {all.map((x) => (
            <section key={x.name} className="grid content-start gap-2" aria-label={`${x.label}: results in R`}>
              <h3 className="text-sm font-medium">
                {x.label} <span className="text-muted-foreground font-normal">· {plural(x.trades, "closed trade")}</span>
              </h3>
              <Columns label={`${x.label}: closed trades by result in R`} columns={x.bands} />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                <Figure label="Average win" value={rMult(x.meanWinR, 2)} />
                <Figure label="Average loss" value={rMult(x.meanLossR, 2)} />
                <Figure label="Win over loss" value={isNum(x.payoff) ? `${num(x.payoff, 2)}×` : "—"} />
                <Figure
                  label="Win rate"
                  value={isNum(x.winRate) ? fracPct(x.winRate, 0) : "—"}
                  hint={isNum(x.breakevenWinRate) ? `breaks even at ${fracPct(x.breakevenWinRate, 0)}` : undefined}
                />
                <Figure label="Best" value={rMult(x.bestR, 2)} />
                <Figure label="Worst" value={rMult(x.worstR, 2)} />
                <Figure label="Middle trade" value={rMult(x.medianR, 2)} />
              </dl>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}
