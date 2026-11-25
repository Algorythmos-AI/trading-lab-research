import { PaneBoundary } from "@/components/client/pane-boundary";
import { GapHunterBody } from "@/components/gap-hunter/gap-hunter-page";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { EnvFrame } from "@/components/ui/env-chip";
import { GAP_HUNTER } from "@/lib/robots";
import { loadGapHunterLive, loadSnapshot, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: GAP_HUNTER.name };

/** The stock robot's own page. `/robot-b`, its address under the old name, redirects here (next.config.ts). */
export default async function GapHunterPage() {
  const [result, live, now] = await Promise.all([loadSnapshot(), loadGapHunterLive(), pageTime()]);
  return (
    <>
      <PageHeading
        title={GAP_HUNTER.name}
        intro="The stock robot, live: what it is doing this minute, its pick and rules, its position, every step it took, its brakes and its results. Paper money only. Read only: nothing here can place, block or cancel an order."
        phoneIntro="The stock robot, live: what it is doing now, its position, its steps and its results. Paper money only."
      />
      {result.status !== "ok" ? <NoSnapshot status={result.status} /> : null}
      <EnvFrame env="paper" label={GAP_HUNTER.name}>
        <PaneBoundary name={`${GAP_HUNTER.name} (paper)`}>
          <GapHunterBody s={result.status === "ok" ? result.snapshot : null} live={live} now={now} />
        </PaneBoundary>
      </EnvFrame>
    </>
  );
}
