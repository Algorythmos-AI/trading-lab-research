import { LedgerRecord, LedgerReview, NoLedger } from "@/components/ledger";
import { PageHeading } from "@/components/page-heading";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { loadLedger } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Card record" };

const INTRO =
  "How the Top 4 Focus Card did against the market, scored after every close: each name's fill and exit, the result in R on the stock and in dollars on one option contract, and the running record. Research only; nothing here is an order.";

export default async function CardRecordPage({ searchParams }: { searchParams: Promise<{ d?: string | string[] }> }) {
  const sp = await searchParams;
  const raw = typeof sp.d === "string" ? sp.d : undefined;
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  // The record comes with every edition, so the newest one draws it whichever day's review is open.
  const [day, latest] = await Promise.all([loadLedger(date), date ? loadLedger() : null]);
  const record = latest ?? day;
  return (
    <>
      <PageHeading title="Card record" intro={INTRO} />
      {day.status === "ok" ? (
        <PaneBoundary name="How the card did">
          <LedgerReview e={day.edition} />
        </PaneBoundary>
      ) : (
        <NoLedger status={day.status} date={date} />
      )}
      {record.status === "ok" ? (
        <PaneBoundary name="Card record">
          <LedgerRecord e={record.edition} current={day.status === "ok" ? day.edition.session : undefined} />
        </PaneBoundary>
      ) : null}
    </>
  );
}
