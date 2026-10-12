import Link from "next/link";
import { notFound } from "next/navigation";
import { NoOptions } from "@/components/options";
import { LiveQuotes } from "@/components/client/live-layer";
import { OptionsName } from "@/components/client/options-name";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { PageHeading } from "@/components/page-heading";
import { sydney, weekDate } from "@/lib/format";
import { hourlyBySymbol } from "@/lib/hourly";
import { interestBySymbol } from "@/lib/oi";
import { editionState, mapView } from "@/lib/options";
import { loadOptions, loadOptionsLive, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ symbol: string }>; searchParams: Promise<Record<"d", string | string[] | undefined>> };

/** A symbol as an address may carry it: letters, digits and a dot, as the edition's own schema allows. */
const asSymbol = (raw: string): string | null => (/^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(raw) ? raw.toUpperCase() : null);

export async function generateMetadata({ params }: Props) {
  const symbol = asSymbol((await params).symbol);
  return { title: symbol ? `${symbol} · Options` : "Options" };
}

/**
 * One name of the Options desk on a page of its own: its map, its facts, its zones and what the rules have done
 * on it. The desk is one click back. A name the edition does not carry is not a page.
 */
export default async function OptionsNamePage({ params, searchParams }: Props) {
  const symbol = asSymbol((await params).symbol);
  if (!symbol) notFound();
  const rawDate = (await searchParams).d;
  const date = typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;
  // The paper positions and the rule states are a view of now, so an older edition is drawn without them.
  const [result, positions] = await Promise.all([loadOptions(date), date ? null : loadOptionsLive()]);
  const back = `/options?s=${symbol}${date ? `&d=${date}` : ""}`;
  if (result.status !== "ok") {
    return (
      <>
        <PageHeading title={symbol} intro="One name of the Options desk." />
        <NoOptions status={result.status} date={date} />
      </>
    );
  }
  const e = result.edition;
  const t = e.tickers.find((x) => x.symbol === symbol);
  if (!t) notFound();
  const now = await pageTime();
  const live = positions?.status === "ok" ? positions.doc : null;
  const interest = interestBySymbol(live, now.getTime(), (s) => (s === symbol ? mapView(t) : null))[symbol] ?? null;
  return (
    <>
      <h1 className="sr-only">{symbol}, Options</h1>
      <nav aria-label="Back" className="w-[min(calc(100vw-2rem),72rem)] justify-self-center text-xs">
        <Link href={back} className="text-muted-foreground hover:text-foreground underline underline-offset-2">
          All names
        </Link>
      </nav>
      <LiveQuotes symbols={symbol} session={e.session} enabled={!date}>
        <PaneBoundary name={symbol}>
          <OptionsName e={e} t={t} live={!date} positions={live ? { ...live, open_interest: null, hourly: null } : null} interest={interest} hourly={hourlyBySymbol(live, [symbol], now.getTime())[symbol] ?? null} stale={!date && editionState(e.session, now) === "stale"} />
        </PaneBoundary>
        <p className="text-muted-foreground w-[min(calc(100vw-2rem),72rem)] justify-self-center text-xs">
          Levels for {weekDate(e.session)}, built from the {weekDate(e.built_from)} close. Source: {e.source ?? "not stated"}. Published {sydney(e.as_of)} Sydney.
          Research only; nothing here is an order.
        </p>
      </LiveQuotes>
    </>
  );
}
