import { HealthBanner } from "@/components/health-banner";
import { HftBooks, HftLearning, HftPairs, HftPhases, HftRecorder, HftSleeves, HftStatus, NoHftSnapshot } from "@/components/hft/panels";
import { PageHeading } from "@/components/page-heading";
import { freshness } from "@/lib/freshness";
import { hftHealth } from "@/lib/hft";
import { requestTime } from "@/lib/now";
import { loadHftSnapshot } from "@/lib/snapshot";
import { list } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "HFT" };

export default async function HftPage() {
  const result = await loadHftSnapshot();
  const now = requestTime().getTime();
  return (
    <>
      <PageHeading
        title="HFT"
        intro="The HFT desk is a separate platform, kept in its own repository, that trades currencies on a broker paper account, fully automatically. This page shows only what that platform publishes."
      />
      {result.status !== "ok" ? (
        <NoHftSnapshot status={result.status} />
      ) : (
        <>
          <HealthBanner health={hftHealth(result.snapshot, freshness(result.snapshot.as_of ?? null, list(result.snapshot.expected_windows), now))} />
          <HftStatus s={result.snapshot} />
          <HftPhases s={result.snapshot} />
          <div className="grid gap-5 lg:grid-cols-2">
            <HftRecorder s={result.snapshot} />
            <HftPairs s={result.snapshot} />
          </div>
          <HftSleeves s={result.snapshot} />
          <div className="grid gap-5 lg:grid-cols-2">
            <HftBooks s={result.snapshot} />
            <HftLearning s={result.snapshot} />
          </div>
        </>
      )}
    </>
  );
}
