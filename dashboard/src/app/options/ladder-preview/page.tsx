// TEMPORARY, fixture only: the price ladders of the focus names, so the owner can look at them before they are wired
// into the Options page. PR 3 of the plan wires the ladder into the focus cards and deletes this route. Outside
// fixture mode (DASHBOARD_FIXTURE=1) it is a 404.
import { notFound } from "next/navigation";
import { PageHeading } from "@/components/page-heading";
import { LadderMini, LevelLadder } from "@/components/level-ladder";
import { LiveQuotes } from "@/components/client/live-layer";
import { withLeaders } from "@/lib/entry-checks";
import { isHalfDay } from "@/lib/options";
import { fixtureMode, loadOptions } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ladder preview" };

export default async function LadderPreview() {
  if (!fixtureMode()) notFound();
  const result = await loadOptions();
  if (result.status !== "ok") notFound();
  const e = result.edition;
  const items = [...(e.focus?.items ?? [])].sort((a, b) => a.rank - b.rank).slice(0, 4);
  const pre = (s: string) => e.focus?.premarket?.items.find((p) => p.symbol === s)?.price ?? null;
  const halfDay = isHalfDay(e);
  const tick = (s: string) => e.tickers.find((t) => t.symbol === s);
  return (
    <>
      <PageHeading title="Ladder preview" intro="Fixture only: the focus names' price ladders before they join the Options page. Research only; nothing here is an order." />
      {items.length === 0 ? <p className="text-sm">No focus names in this fixture: set the fx cookie to a variant with focus.</p> : null}
      <LiveQuotes symbols={withLeaders(e.tickers.map((t) => t.symbol)).join(",")} session={e.session} enabled>
        <section aria-label="Fourfold glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {items.map((i) => (
            <div key={i.symbol} className="bg-card grid gap-1 rounded-lg border p-2">
              <p className="text-sm font-semibold">{i.symbol}</p>
              <LadderMini item={i} ticker={tick(i.symbol)} session={e.session} halfDay={halfDay} closeDate={e.built_from ?? null} premarket={pre(i.symbol)} />
            </div>
          ))}
        </section>
        <section aria-label="Ladders" className="grid gap-4 md:grid-cols-2">
          {items.map((i, n) => (
            <div key={i.symbol} className="bg-card grid gap-2 rounded-lg border p-3">
              <p className="text-base font-bold">
                {i.symbol}
                <span className="text-muted-foreground ml-2 text-sm font-normal">{n === 0 ? "call side highlighted" : n === 1 ? "put side highlighted" : "no side highlighted, one alternative shown as live (preview)"}</span>
              </p>
              <LevelLadder item={i} ticker={tick(i.symbol)} session={e.session} halfDay={halfDay} closeDate={e.built_from ?? null} premarket={pre(i.symbol)} highlight={n === 0 ? "call" : n === 1 ? "put" : undefined} liveAlt={n === 2 ? { kind: "failed_break", side: "call" } : null} />
            </div>
          ))}
        </section>
      </LiveQuotes>
    </>
  );
}
