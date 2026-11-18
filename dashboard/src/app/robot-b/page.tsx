import { PaneBoundary } from "@/components/client/pane-boundary";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { RobotBBody } from "@/components/robot-b/robot-b-page";
import { EnvFrame } from "@/components/ui/env-chip";
import { EVIDENCE } from "@/lib/robot-b";
import { loadSnapshot, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Robot B" };

export default async function RobotBPage() {
  const [result, now] = await Promise.all([loadSnapshot(), pageTime()]);
  return (
    <>
      <PageHeading
        title="Robot B"
        intro="Everything about the stock robot in one place: whether its edge is proven, what blocks it, how the paper desk is doing against its lines, and the research still owed. Paper money only. Read only: nothing here can place, block or cancel an order."
        phoneIntro="The stock robot in one place: proven or not, what blocks it, and the paper desk against its lines. Paper money only."
      />
      {result.status !== "ok" ? <NoSnapshot status={result.status} /> : null}
      <EnvFrame env="paper" label="Robot B">
        <PaneBoundary name="Robot B (paper)">
          <RobotBBody s={result.status === "ok" ? result.snapshot : null} e={EVIDENCE} now={now} />
        </PaneBoundary>
      </EnvFrame>
    </>
  );
}
