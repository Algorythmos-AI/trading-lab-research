import { PageHeading } from "@/components/page-heading";
import { TradesBody } from "@/components/trades-page";
import { loadJournal, loadOptionsClone, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trades" };

export default async function TradesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [q, result, now, clone] = await Promise.all([searchParams, loadJournal(), pageTime(), loadOptionsClone()]);
  return (
    <>
      <PageHeading
        title="Trades"
        intro="Every trade from your own brokerage account, live through the trading day and back to the first one: what each one made or lost, where the money was made and lost, and the patterns worth learning from. A record only; nothing here can trade."
      />
      <TradesBody result={result} clone={clone} q={q} now={now} />
    </>
  );
}
