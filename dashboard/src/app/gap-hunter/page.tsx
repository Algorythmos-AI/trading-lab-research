import { PaneBoundary } from "@/components/client/pane-boundary";
import { GapHunterBody } from "@/components/gap-hunter/gap-hunter-page";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { EnvFrame } from "@/components/ui/env-chip";
import { GAP_HUNTER } from "@/lib/robots";
import { loadSnapshot, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: GAP_HUNTER.name };

/** The stock robot's own page. `/robot-b`, its address under the old name, redirects here (next.config.ts). */
export default async function GapHunterPage() {
  const [result, now] = await Promise.all([loadSnapshot(), pageTime()]);
  return (
    <>
      <PageHeading
        title={GAP_HUNTER.name}
        intro="The stock robot in one place: where it stands, the morning funnel in counts, its sessions, its results and its alerts. Paper money only. Read only: nothing here can place, block or cancel an order."
        phoneIntro="The stock robot in one place: where it stands, the morning funnel, its sessions and its alerts. Paper money only."
      />
      {result.status !== "ok" ? <NoSnapshot status={result.status} /> : null}
      <EnvFrame env="paper" label={GAP_HUNTER.name}>
        <PaneBoundary name={`${GAP_HUNTER.name} (paper)`}>
          <GapHunterBody s={result.status === "ok" ? result.snapshot : null} now={now} />
        </PaneBoundary>
      </EnvFrame>
    </>
  );
}
