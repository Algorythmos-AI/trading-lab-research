import { HealthBanner } from "@/components/health-banner";
import { PaneBoundary } from "@/components/client/pane-boundary";
import { NoJournal } from "@/components/journal";
import { KillNotice } from "@/components/overview/lab-panels";
import { AccountHero, HealthLine, NextSessionPanel, PatternsPanel, PnlOverview, RobotsStrip } from "@/components/overview/home";
import { computeHealth } from "@/lib/health";
import { skippedLine } from "@/lib/journal";
import { loadJournal, loadOptions, loadOptionsClone, loadRadar, loadSnapshot, pageTime } from "@/lib/snapshot";
import { list } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The Stocks home page: the owner's own Webull trading first, then the next session's names, then the paper robots
 * and the lab's health in a line each. The lab's own panels are on Research and Operations.
 */
export default async function OverviewPage() {
  const [journal, snap, options, radar, clone, now] = await Promise.all([loadJournal(), loadSnapshot(), loadOptions(), loadRadar(), loadOptionsClone(), pageTime()]);
  const s = snap.status === "ok" ? snap.snapshot : null;
  const health = computeHealth(s, now);
  const doc = journal.status === "ok" ? journal.doc : null;
  // Rows of the journal that could not be read are left out of every figure here (loadJournal); say how many.
  const unread = journal.status === "ok" ? skippedLine(journal.skipped ?? 0) : null;
  return (
    <>
      <h1 className="sr-only">Overview</h1>
      {health.level === "red" ? <HealthBanner health={health} /> : null}
      {s ? <KillNotice s={s} /> : null}
      {doc ? (
        <>
          {unread ? (
            <p data-journal-skipped={journal.status === "ok" ? journal.skipped : 0} className="text-warn text-xs font-medium">
              Your trade journal: {unread}
            </p>
          ) : null}
          <PaneBoundary name="Your account">
            <AccountHero doc={doc} now={now} />
          </PaneBoundary>
          <PaneBoundary name="Profit and loss">
            <PnlOverview trades={doc.trades} now={now} />
          </PaneBoundary>
        </>
      ) : (
        <NoJournal status={journal.status === "ok" ? "missing" : journal.status} />
      )}
      <PaneBoundary name="Next session">
        <NextSessionPanel options={options.status === "ok" ? options.edition : null} radar={radar.status === "ok" ? radar.edition : null} />
      </PaneBoundary>
      {doc ? (
        <PaneBoundary name="Patterns">
          <PatternsPanel trades={doc.trades} now={now} />
        </PaneBoundary>
      ) : null}
      <PaneBoundary name="The robots and the scan">
        <RobotsStrip s={s} clone={clone.status === "ok" ? clone.doc : null} />
      </PaneBoundary>
      {health.level !== "red" ? (
        <PaneBoundary name="Lab health">
          <HealthLine health={health} needsYou={list(s?.overview?.needs_you).length} />
        </PaneBoundary>
      ) : null}
    </>
  );
}
