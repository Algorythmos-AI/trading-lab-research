import { HealthBanner } from "@/components/health-banner";
import { NoJournal } from "@/components/journal";
import { KillNotice } from "@/components/overview/lab-panels";
import { AccountHero, HealthLine, NextSessionPanel, PatternsPanel, PnlOverview, RobotsStrip } from "@/components/overview/home";
import { computeHealth } from "@/lib/health";
import { loadJournal, loadOptions, loadRadar, loadSnapshot, pageTime } from "@/lib/snapshot";
import { list } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The Stocks home page: the owner's own Webull trading first, then the next session's names, then the paper robots
 * and the lab's health in a line each. The lab's own panels are on Research and Operations.
 */
export default async function OverviewPage() {
  const [journal, snap, options, radar, now] = await Promise.all([loadJournal(), loadSnapshot(), loadOptions(), loadRadar(), pageTime()]);
  const s = snap.status === "ok" ? snap.snapshot : null;
  const health = computeHealth(s, now);
  const doc = journal.status === "ok" ? journal.doc : null;
  return (
    <>
      <h1 className="sr-only">Overview</h1>
      {health.level === "red" ? <HealthBanner health={health} /> : null}
      {s ? <KillNotice s={s} /> : null}
      {doc ? (
        <>
          <AccountHero doc={doc} now={now} />
          <PnlOverview trades={doc.trades} now={now} />
        </>
      ) : (
        <NoJournal status={journal.status === "ok" ? "missing" : journal.status} />
      )}
      <NextSessionPanel options={options.status === "ok" ? options.edition : null} radar={radar.status === "ok" ? radar.edition : null} />
      {doc ? <PatternsPanel trades={doc.trades} now={now} /> : null}
      <RobotsStrip s={s} />
      {health.level !== "red" ? <HealthLine health={health} needsYou={list(s?.overview?.needs_you).length} /> : null}
    </>
  );
}
