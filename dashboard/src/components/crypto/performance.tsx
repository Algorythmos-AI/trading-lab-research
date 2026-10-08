import { CalendarRange, Filter, TrendingDown } from "lucide-react";
import { Funnel, type FunnelRow } from "@/components/charts/funnel";
import { LinesChart } from "@/components/charts/lines-chart";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { code, type Crypto } from "@/lib/crypto";
import { fracPct, num, signed } from "@/lib/format";
import { deskFunnel, drawdownLines, monthlyReturns, signalFunnels } from "@/lib/performance";
import { equityLines } from "@/lib/tournament";
import { cn } from "@/lib/utils";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const toneOf = (v: number | null | undefined) => (!isNum(v) || Math.abs(v) < 0.005 ? "text-foreground" : v > 0 ? "text-good" : "text-bad");
const LINE_COLOURS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-7)", "var(--chart-8)", "var(--chart-6)"];
const monthName = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "short", year: "numeric" });
const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const utcDay = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? dayName.format(new Date(t)) : null;
};

/** How far each paper book sits below its own highest mark: the picture a rising line hides. */
export function DrawdownPanel({ s }: { s: Crypto }) {
  const lines = drawdownLines(equityLines(s));
  const drawn = lines.filter((l) => l.points.length >= 2);
  return (
    <Panel
      title="Fall from the high"
      icon={TrendingDown}
      means="How far each paper book is below its own highest point so far, in percent of that point. Zero means the book is at its high. A strategy is lived through its falls, so this is read beside the return, not after it. Paper money, incubation: none of it is evidence of an edge."
    >
      {drawn.length === 0 ? (
        <Empty title="Not enough history yet">A fall needs at least two marks of a book; the host keeps one every four hours.</Empty>
      ) : (
        <div className="grid gap-3">
          <LinesChart
            label="Each paper book's fall from its own highest mark, in percent"
            series={lines.map((l, i) => ({
              key: l.name,
              label: l.label,
              color: l.baseline ? "var(--chart-na)" : (LINE_COLOURS[i % LINE_COLOURS.length] as string),
              dashed: l.baseline,
              points: l.points.map((p) => ({ t: p.t, v: p.pct })),
            }))}
          />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
            {lines.map((l) => (
              <div key={l.name} className="min-w-0">
                <dt className="text-muted-foreground truncate text-xs">{l.label}</dt>
                <dd className={cn("font-mono text-sm font-medium", toneOf(l.worstPct))}>{isNum(l.worstPct) ? `deepest ${signed(l.worstPct, 2)}%` : "—"}</dd>
                <dd className="text-muted-foreground text-xs">{isNum(l.nowPct) ? (Math.abs(l.nowPct) < 0.005 ? "at its high now" : `now ${signed(l.nowPct, 2)}%`) : "one mark so far"}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Panel>
  );
}

/** Each book's return by calendar month (UTC). */
export function MonthlyReturnsPanel({ s }: { s: Crypto }) {
  const m = monthlyReturns(equityLines(s));
  const books = m.books.filter((b) => Object.keys(b.byMonth).length > 0);
  return (
    <Panel
      title="Return by month"
      icon={CalendarRange}
      means="Each paper book's return in each calendar month (UTC), fees included: its last mark of the month against its last mark of the month before, or against its start in its first month. The newest month is the month so far. The marks cover the last 90 days."
    >
      {books.length === 0 ? (
        <Empty title="No book has published a mark yet" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Book</TableHead>
                {m.months.map((k) => (
                  <TableHead key={k} className="text-right whitespace-nowrap">
                    {monthName.format(new Date(`${k}-01T00:00:00Z`))}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {books.map((b) => (
                <TableRow key={b.name}>
                  <TableCell className={cn("whitespace-nowrap", b.baseline && "text-muted-foreground")}>{b.label}</TableCell>
                  {m.months.map((k) => {
                    const v = b.byMonth[k];
                    return (
                      <TableCell key={k} className={cn("text-right font-mono", toneOf(v))}>
                        {isNum(v) ? `${signed(v, 2)}%` : "—"}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

function rowsOf(fired: number, entered: number, refused: { code: string; count: number }[]): FunnelRow[] {
  return [
    { key: "fired", label: "Rule fired", count: fired },
    { key: "entered", label: "Bought", count: entered, fill: "bg-good-fill" },
    ...refused.map((r) => ({ key: `r-${r.code}`, label: <span className="[overflow-wrap:anywhere]">{code(r.code)}</span>, count: r.count, inner: true, fill: "bg-neutral-fill" })),
  ];
}

/** Of the signals each sleeve's rule produced, how many were bought and what refused the rest. */
export function SignalFunnelPanel({ s }: { s: Crypto }) {
  const funnels = signalFunnels(s);
  const desk = deskFunnel(funnels);
  const since = funnels.map((f) => f.since).filter((v): v is string => typeof v === "string").sort()[0] ?? null;
  return (
    <Panel
      title="From signal to trade"
      icon={Filter}
      means="Every time a strategy's rule was met, and what became of it: bought, or refused and by what. A refusal with several reasons is counted under its first. On two years of history about seven signals in ten are refused because the book is already full or already holds the coin, so the book, not the rule, decides how many trades there are."
    >
      {funnels.length === 0 ? (
        <Empty title="No signal recorded yet">The counts appear with the first 4-hour bar on which a rule is met.</Empty>
      ) : (
        <div className="grid gap-5">
          <div className="grid gap-2">
            <p className="text-sm">
              <span className="font-medium">All sleeves</span>
              <span className="text-muted-foreground">
                {" "}
                · {num(desk.entered)} of {num(desk.fired)} bought ({fracPct(desk.fired > 0 ? desk.entered / desk.fired : null, 0)}){utcDay(since) ? ` · since ${utcDay(since)}` : ""}
              </span>
            </p>
            <Funnel label="All sleeves: signals fired, bought, and refused by reason" rows={rowsOf(desk.fired, desk.entered, desk.refused)} />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            {funnels.map((f) => (
              <div key={f.name} className="grid content-start gap-2">
                <p className="text-sm">
                  <span className="font-medium">{f.label}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {num(f.entered)} of {num(f.fired)} bought
                  </span>
                </p>
                <Funnel label={`${f.label}: signals fired, bought, and refused by reason`} rows={rowsOf(f.fired, f.entered, f.refused)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
