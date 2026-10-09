import { ArrowUpRight, Ban, BookOpen, Inbox, ListChecks } from "lucide-react";
import Link from "next/link";
import { Empty } from "@/components/empty";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { num, pct, shortDate, sydney } from "@/lib/format";
import { levelPosition, researched, stanceTone, tickersOf, type Radar, type RadarNote, type RadarTicker } from "@/lib/radar";
import type { RadarResult } from "@/lib/snapshot";
import { cn } from "@/lib/utils";

export function NoRadar({ status, date }: { status: Exclude<RadarResult["status"], "ok">; date?: string }) {
  if (status === "error") {
    return <Empty title="Storage could not be read">The dashboard could not read the radar. Reload in a minute.</Empty>;
  }
  return date ? (
    <Empty icon={Inbox} title={`No radar edition for ${shortDate(date)}`}>
      <Link href="/radar" className="underline">
        Show the newest edition
      </Link>
    </Empty>
  ) : (
    <Empty icon={Inbox} title="The radar has not published yet">
      Each weekday&apos;s pre-market radar run publishes here when it finishes.
    </Empty>
  );
}

function StanceBadge({ stance }: { stance: string | null | undefined }) {
  if (!stance) return null;
  return <Badge variant={stanceTone(stance)}>{stance}</Badge>;
}

function TagBadge({ tag }: { tag: RadarTicker["tag"] }) {
  if (tag === "new") return <Badge variant="info">New</Badge>;
  if (tag === "risk") return <Badge variant="bad">Risk</Badge>;
  return null;
}

export function EditionPanel({ r }: { r: Radar }) {
  return (
    <Panel
      title={r.title ?? `${r.edition_date} | PRE-MARKET RADAR`}
      means={`Prices: ${r.prices_as_of ?? "not stated"}. Published ${sydney(r.as_of)} Sydney.`}
      icon={BookOpen}
      action={
        r.report_url ? (
          <a href={r.report_url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 text-sm">
            Full report <ArrowUpRight aria-hidden className="size-3.5" />
          </a>
        ) : null
      }
    >
      <div className="grid gap-3 text-sm">
        {r.summary ? <p className="max-w-prose">{r.summary}</p> : null}
        {r.regime ? (
          <p className="text-muted-foreground max-w-prose">
            <span className="text-foreground font-medium">Market: </span>
            {r.regime}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function LevelBar({ t }: { t: RadarTicker }) {
  const pos = levelPosition(t);
  if (pos === null) return null;
  return (
    <div className="grid gap-1" aria-label={`Price ${num(t.price, 2)} between support ${num(t.support, 2)} and 52-week high ${num(t.high_52w, 2)}`}>
      <div className="bg-muted relative h-1.5 rounded-full">
        <div className="bg-primary/40 absolute inset-y-0 left-0 rounded-full" style={{ width: `${pos * 100}%` }} />
        <div className="bg-primary absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${pos * 100}%` }} />
      </div>
      <div className="text-muted-foreground flex justify-between font-mono text-[0.6875rem]">
        <span>support {num(t.support, 2)}</span>
        <span>52w high {num(t.high_52w, 2)}</span>
      </div>
    </div>
  );
}

export function WatchlistPanel({ r, name, note }: { r: Radar; name: string; note: string | null | undefined }) {
  const rows = tickersOf(r, name);
  return (
    <Panel title={name} means={note ?? "One of the six IBKR lists, as this edition left it."} icon={ListChecks}>
      {rows.length === 0 ? (
        <Empty title="No names on this list today" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ticker</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Support</TableHead>
              <TableHead className="text-right">To support</TableHead>
              <TableHead className="text-right">Resistance</TableHead>
              <TableHead className="hidden min-w-64 sm:table-cell">Why it is here</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => (
              <TableRow key={t.symbol}>
                <TableCell className="align-top">
                  <a href={`#t-${t.symbol}`} className="font-mono font-semibold">
                    {t.symbol}
                  </a>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <TagBadge tag={t.tag} />
                    <StanceBadge stance={t.stance} />
                  </div>
                  {t.why ? <p className="text-muted-foreground mt-1 max-w-56 text-xs whitespace-normal sm:hidden">{t.why}</p> : null}
                </TableCell>
                <TableCell className="text-right align-top font-mono">{num(t.price, 2)}</TableCell>
                <TableCell className="text-right align-top font-mono">{num(t.support, 2)}</TableCell>
                <TableCell className="text-right align-top font-mono">{pct(t.to_support_pct)}</TableCell>
                <TableCell className="text-right align-top font-mono">{t.resistance == null ? "none above" : num(t.resistance, 2)}</TableCell>
                <TableCell className="hidden align-top text-[0.8125rem] whitespace-normal sm:table-cell">{t.why ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

const CONFIDENCE: Record<string, "good" | "warn" | "bad"> = { High: "good", Medium: "warn", Low: "bad" };

function Note({ n }: { n: RadarNote }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_1fr] sm:gap-3">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{n.label ?? "Note"}</p>
      <div className="text-sm">
        <p>{n.text ?? "—"}</p>
        <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          {[n.source, n.date].filter(Boolean).join(", ")}
          {n.confidence ? <Badge variant={CONFIDENCE[n.confidence] ?? "neutral"}>{n.confidence}</Badge> : null}
        </p>
      </div>
    </div>
  );
}

export function TickerCards({ r }: { r: Radar }) {
  const cards = researched(r);
  if (cards.length === 0) return null;
  return (
    <section aria-label="Research notes" className="grid gap-5 lg:grid-cols-2">
      {cards.map((t) => (
        <Panel
          key={t.symbol}
          id={`t-${t.symbol}`}
          title={
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono">{t.symbol}</span>
              {t.company ? <span className="text-muted-foreground text-sm font-normal">{t.company}</span> : null}
            </span>
          }
          means={
            <span className="font-mono">
              {num(t.price, 2)} · {pct(t.to_support_pct)} to support · {pct(t.off_high_pct)} off high
              {(t.lists ?? []).length > 0 ? ` · ${(t.lists ?? []).join(", ")}` : ""}
            </span>
          }
          action={<StanceBadge stance={t.stance} />}
        >
          <div className="grid gap-4">
            <LevelBar t={t} />
            {t.why ? <p className="text-sm font-medium">{t.why}</p> : null}
            {(t.notes ?? []).map((n, i) => (
              <Note key={i} n={n} />
            ))}
          </div>
        </Panel>
      ))}
    </section>
  );
}

export function AvoidPanel({ r }: { r: Radar }) {
  const rows = r.avoid ?? [];
  if (rows.length === 0) return null;
  return (
    <Panel title="Names to avoid today" means="On none of the lists, and why, so they do not tempt you." icon={Ban}>
      <ul className="grid gap-2 text-sm">
        {rows.map((a, i) => (
          <li key={i} className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
            <span className="font-mono font-semibold">
              {a.symbols ?? "—"}
              {a.price ? <span className="text-muted-foreground ml-2 font-normal">{a.price}</span> : null}
            </span>
            <span className="text-muted-foreground">{a.why ?? "—"}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function EditionPicker({ dates, current, base = "/radar" }: { dates: string[]; current: string; base?: string }) {
  if (dates.length < 2) return null;
  return (
    <nav aria-label="Earlier editions" className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground mr-1">Editions:</span>
      {dates.map((d, i) => (
        <Link
          key={d}
          href={i === 0 ? base : `${base}?d=${d}`}
          aria-current={d === current ? "page" : undefined}
          className={cn(
            "rounded border px-2 py-0.5 font-mono",
            d === current ? "bg-primary text-primary-foreground border-transparent" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {d}
        </Link>
      ))}
    </nav>
  );
}
