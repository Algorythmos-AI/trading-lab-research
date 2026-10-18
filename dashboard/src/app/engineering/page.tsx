import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { LAB_PLATFORM_TOC, LabPlatform } from "@/components/wiki/lab-platform";
import { WikiLayout, type TocGroup } from "@/components/wiki/kit";
import {
  ArchitectureSection,
  DaySection,
  FeedsSection,
  GatesSection,
  GlanceSection,
  OrdersSection,
  RunbooksSection,
  STOCKS_TOC,
  stocksFeeds,
} from "@/components/wiki/stocks";
import { requestTime } from "@/lib/now";
import { loadJournal, loadOptions, loadOptionsLive, loadRadar, loadSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Engineering" };

const TOC: TocGroup[] = [STOCKS_TOC, LAB_PLATFORM_TOC];

export default async function EngineeringPage() {
  const [result, positions, levels, radar, journal] = await Promise.all([loadSnapshot(), loadOptionsLive(), loadOptions(), loadRadar(), loadJournal()]);
  const s = result.status === "ok" ? result.snapshot : null;
  const now = requestTime();
  const feeds = stocksFeeds({ snapshot: result, positions, levels, radar, journal }, now);
  // The same fallback /api/health uses: CI inlines BUILD_SHA; a Vercel git deploy has only its own variable.
  const siteSha = process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null;
  return (
    <>
      <PageHeading
        title="Engineering"
        intro="How the Stocks site works: where each page's data comes from and whether it is on time, what runs when, how the paper robot stays safe, and the lab platform it shares with the crypto desk. The dots are live."
      />
      {result.status !== "ok" ? <NoSnapshot status={result.status} /> : null}
      <WikiLayout toc={TOC}>
        <GlanceSection s={s} feeds={feeds} now={now} siteSha={siteSha} />
        <ArchitectureSection s={s} feeds={feeds} now={now} />
        <FeedsSection feeds={feeds} now={now} />
        <DaySection s={s} feeds={feeds} now={now} />
        {s ? (
          <>
            <OrdersSection s={s} />
            <GatesSection s={s} />
          </>
        ) : null}
        <RunbooksSection />
        <LabPlatform s={s} />
      </WikiLayout>
    </>
  );
}
