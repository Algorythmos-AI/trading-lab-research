import { ArrowLeft, History as HistoryIcon, Network, Share2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { Panel } from "@/components/panel";
import { KindDot } from "@/components/registry/analytics";
import { NeighbourGraph } from "@/components/registry/graph";
import { History, RecordFlags, Relations } from "@/components/registry/records";
import { BranchSwitch, StaleBanner, SyncBadge } from "@/components/registry/sync-panel";
import { Empty } from "@/components/empty";
import { Notice } from "@/components/ui/notice";
import { shortSha } from "@/lib/format";
import { requestTime } from "@/lib/now";
import { registryState } from "@/lib/registry-run";
import { ISSUE_LABEL, KIND_LABEL, RECORD_ID_RE, STATUS_LABEL, ago, commitUrl, inbound, kindOf, mainState, recordHref, searchUrl } from "@/lib/registry-view";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }) {
  const { id } = await params;
  return { title: RECORD_ID_RE.test(id) ? id : "Research record" };
}

export default async function RecordPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { id } = await params;
  if (!RECORD_ID_RE.test(id)) notFound();
  const sp = await searchParams;
  const branch = sp.b === "main" ? "main" : "integration";
  const [s, other] = await Promise.all([registryState(branch), branch === "integration" ? registryState("main") : Promise.resolve(null)]);
  const nowMs = requestTime().getTime();
  const back = branch === "main" ? "/research/records?b=main" : "/research/records";
  const kind = kindOf(id) ?? "dec";
  const doc = s.load.status === "ok" ? s.load.doc : null;
  const rec = doc?.records.find((r) => r.id === id) ?? null;
  const tomb = doc?.tombstones.find((t) => t.id === id) ?? null;
  const main = other?.load.status === "ok" ? other.load.doc : null;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={back} className="text-muted-foreground flex items-center gap-1.5 text-sm underline-offset-2 hover:underline">
          <ArrowLeft aria-hidden className="size-4" />
          All records
        </Link>
        <div className="flex items-center gap-3">
          <SyncBadge state={s.status.state} label={s.status.label} />
          <BranchSwitch branch={branch} base={`/research/records/${id}`} />
        </div>
      </div>
      <div className="grid gap-2">
        <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold tracking-tight sm:text-2xl">
          <KindDot kind={kind} />
          <span className="font-mono">{id}</span>
          <span className="text-muted-foreground text-base font-normal">{KIND_LABEL[kind]}</span>
        </h1>
        {rec && doc ? <RecordFlags rec={rec} main={branch === "integration" && main ? mainState(rec, main) : null} issues={doc.issues} /> : null}
      </div>
      <StaleBanner s={s} nowMs={nowMs} />
      {!doc ? (
        <Notice tone={s.load.status === "error" ? "bad" : "warn"} size="sm">
          {s.load.status === "error" ? `The stored index for ${branch} could not be read.` : `No index for ${branch} has arrived yet.`}
        </Notice>
      ) : tomb ? (
        <Panel title="No longer on this branch" icon={HistoryIcon} means="Kept from git history so a link to it still says where it went.">
          <p className="text-sm">
            {tomb.state === "renamed" && tomb.renamed_to ? (
              <>
                Renamed to{" "}
                <Link href={recordHref(tomb.renamed_to, branch)} className="font-mono underline-offset-2 hover:underline">
                  {tomb.renamed_to}
                </Link>
              </>
            ) : (
              "Deleted"
            )}{" "}
            {ago(tomb.at, nowMs)} in{" "}
            <a href={commitUrl(doc.repo, tomb.sha)} className="font-mono underline-offset-2 hover:underline">
              {shortSha(tomb.sha)}
            </a>
            . Its last status was {STATUS_LABEL[tomb.last_status].toLowerCase()}.
          </p>
        </Panel>
      ) : !rec ? (
        <Empty title={`${id} is not in the ${branch} index`}>
          No file on this branch has this id, and its history holds no record of one.{" "}
          {branch === "main" ? (
            <Link href={recordHref(id, "integration")} className="underline">
              Look on integration
            </Link>
          ) : null}
        </Empty>
      ) : (
        <>
          <PaneBoundary name="The map">
            <Panel title="Dependency map" icon={Network} means="This record and every record it links to or is linked from. Open any box for its own map.">
              <NeighbourGraph doc={doc} id={id} branch={branch} />
            </Panel>
          </PaneBoundary>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Links" icon={Share2} means="Read from the record's own labelled lines (depends on, amends, experiment and so on) and from the records that name it.">
              <Relations rec={rec} ins={inbound(doc).get(id) ?? []} ids={new Set([...doc.records.map((r) => r.id), ...doc.tombstones.map((t) => t.id)])} branch={branch} />
            </Panel>
            <Panel title="History" icon={HistoryIcon} means="From git: when the file first appeared and last changed on this branch.">
              <div className="grid gap-3">
                <History rec={rec} repo={doc.repo} nowMs={nowMs} />
                {doc.issues.filter((i) => i.id === id).map((i, n) => (
                  <Notice key={n}>
                    {ISSUE_LABEL[i.code]}
                    {i.to ? ` (${i.to})` : ""}
                  </Notice>
                ))}
                <p className="text-sm">
                  <a href={searchUrl(doc.repo, id)} className="underline-offset-2 hover:underline">
                    Find the file on GitHub
                  </a>
                </p>
              </div>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
