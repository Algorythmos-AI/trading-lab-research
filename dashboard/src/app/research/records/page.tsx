import { Empty } from "@/components/empty";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { PageHeading } from "@/components/page-heading";
import { DependedOn, Headline, Recent, StatusMix, Timeline } from "@/components/registry/analytics";
import { Families, Issues, RecordsExplorer, Tombstones } from "@/components/registry/records";
import { BranchSwitch, StaleBanner, SyncPanel } from "@/components/registry/sync-panel";
import { Notice } from "@/components/ui/notice";
import { requestTime } from "@/lib/now";
import { registryState } from "@/lib/registry-run";
import { parseFilters } from "@/lib/registry-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Research records" };

type Search = Record<string, string | string[] | undefined>;

export default async function RecordsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const branch = sp.b === "main" ? "main" : "integration";
  const [s, other] = await Promise.all([registryState(branch), registryState(branch === "main" ? "integration" : "main")]);
  const nowMs = requestTime().getTime();
  const base = branch === "main" ? "/research/records?b=main" : "/research/records";
  const doc = s.load.status === "ok" ? s.load.doc : null;
  const main = branch === "integration" && other.load.status === "ok" ? other.load.doc : null;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeading
          title="Research records"
          intro="Every decision, hypothesis, experiment and lesson in the repository, how they link, how they changed, and whether this view is current with GitHub. Ids, statuses, dates and links only, until record text is switched on."
          phoneIntro="Every research record, how they link, and whether this view is current with GitHub."
        />
        <BranchSwitch branch={branch} base="/research/records" />
      </div>
      <SyncPanel s={s} other={other} repo={doc?.repo ?? null} nowMs={nowMs} />
      <StaleBanner s={s} nowMs={nowMs} />
      {s.load.status === "missing" ? (
        <Empty title={`No index for ${branch} yet`}>The registry job has not sent one for this branch. Refresh starts it; the page fills in when it lands.</Empty>
      ) : s.load.status === "error" ? (
        <Notice tone="bad" size="sm" role="alert">
          The stored index for {branch} could not be read or no longer matches its schema. Nothing from it is shown. Refresh sends a new one.
        </Notice>
      ) : doc ? (
        <>
          <PaneBoundary name="The headline numbers">
            <Headline doc={doc} nowMs={nowMs} base={base} />
          </PaneBoundary>
          <div className="grid gap-5 lg:grid-cols-2">
            <PaneBoundary name="Status by kind">
              <StatusMix doc={doc} nowMs={nowMs} base={base} />
            </PaneBoundary>
            <PaneBoundary name="The timeline">
              <Timeline doc={doc} />
            </PaneBoundary>
            <PaneBoundary name="Recently changed">
              <Recent doc={doc} nowMs={nowMs} branch={branch} />
            </PaneBoundary>
            <PaneBoundary name="Most depended on">
              <DependedOn doc={doc} branch={branch} />
            </PaneBoundary>
          </div>
          {branch === "integration" && other.load.status !== "ok" ? (
            <Notice>Main&apos;s index is not on file, so no record can say whether it is on main yet.</Notice>
          ) : null}
          <PaneBoundary name="The records">
            <RecordsExplorer doc={doc} main={main} f={parseFilters(sp)} branch={branch} nowMs={nowMs} action="/research/records" />
          </PaneBoundary>
          <PaneBoundary name="Needs a look">
            <Issues doc={doc} branch={branch} />
          </PaneBoundary>
          <div className="grid gap-5 lg:grid-cols-2">
            <PaneBoundary name="Trial families">
              <Families doc={doc} branch={branch} />
            </PaneBoundary>
            <PaneBoundary name="Deleted and renamed">
              <Tombstones doc={doc} branch={branch} nowMs={nowMs} />
            </PaneBoundary>
          </div>
        </>
      ) : null}
    </>
  );
}
