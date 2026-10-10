import { NoCryptoSnapshot } from "@/components/crypto/panels";
import { PageHeading } from "@/components/page-heading";
import { LAB_PLATFORM_TOC, LabPlatform } from "@/components/wiki/lab-platform";
import {
  ArchitectureSection,
  ChallengersSection,
  ClockSection,
  ControlsSection,
  CRYPTO_TOC,
  CycleSection,
  GlanceSection,
  LearningSection,
  LimitsSection,
} from "@/components/wiki/crypto";
import { ToneDot, WikiLayout, WikiSection, type TocGroup } from "@/components/wiki/kit";
import type { Crypto } from "@/lib/crypto";
import { duration, sydney } from "@/lib/format";
import { requestTime } from "@/lib/now";
import { loadCryptoSnapshot, loadSnapshot } from "@/lib/snapshot";
import { entries } from "@/lib/types";
import { jobDot } from "@/lib/wiki";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crypto engineering" };

const TOC: TocGroup[] = [CRYPTO_TOC, LAB_PLATFORM_TOC];

/** The crypto desk's scheduled jobs in the order a day meets them, with what each one does. */
const JOBS: { key: string; name: string; what: string; when: string }[] = [
  { key: "crypto", name: "Bar cycle", what: "reads the market, manages exits, then entries, on every paper book", when: "every 15 min, 10 s after the bar" },
  { key: "dashboard-crypto", name: "Dashboard publish", what: "builds and signs this desk's snapshot", when: "every 15 min" },
  { key: "crypto-challengers", name: "Challengers", what: "draws and backtests new candidate strategies", when: "daily 03:30 New York" },
  { key: "crypto-learn", name: "Learning", what: "retrains and scores the model, which acts only once it has earned it", when: "daily 04:30 New York" },
];

export default async function CryptoEngineeringPage() {
  const [crypto, stocks] = await Promise.all([loadCryptoSnapshot(), loadSnapshot()]);
  const c = crypto.status === "ok" ? crypto.snapshot : null;
  const now = requestTime();
  return (
    <>
      <PageHeading
        title="Engineering"
        intro="How the crypto desk is built: the paper books, the bar cycle, the clock it runs on, its limits, how it learns, and the lab platform it shares with the stocks desk. Pictures lead; the dots on them are live."
      />
      {crypto.status !== "ok" ? <NoCryptoSnapshot status={crypto.status} /> : null}
      <WikiLayout toc={TOC}>
        {c ? (
          <>
            <GlanceSection s={c} />
            <ArchitectureSection s={c} />
            <CycleSection s={c} />
            <ClockSection s={c} now={now} />
            <LimitsSection s={c} />
            <LearningSection s={c} />
            <ChallengersSection s={c} />
          </>
        ) : null}
        <WikiSection
          id="jobs"
          eyebrow="Crypto desk"
          title="The desk's jobs"
          lede="Four scheduled jobs make up the desk. Each goes through the same job runner as the stocks desk's: lock, preflight, deadline, heartbeat."
        >
          {c ? <JobList s={c} /> : <p className="text-muted-foreground text-sm">No crypto snapshot to read the jobs from.</p>}
        </WikiSection>
        <ControlsSection />
        <LabPlatform s={stocks.status === "ok" ? stocks.snapshot : null} />
      </WikiLayout>
    </>
  );
}

function JobList({ s }: { s: Crypto }) {
  const last = new Map(entries(s.jobs?.last));
  const known = new Set(JOBS.map((j) => j.key));
  const extra = [...last.keys()].filter((k) => !known.has(k)).map((k) => ({ key: k, name: k, what: "", when: "" }));
  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-label="The crypto desk's jobs and their last runs">
      {[...JOBS, ...extra].map((j) => {
        const run = last.get(j.key);
        const dot = jobDot(run);
        return (
          <li key={j.key} className="bg-card grid gap-1 rounded-lg border p-3.5">
            <div className="flex items-center gap-2">
              <ToneDot tone={dot.tone} pulse={dot.pulse} />
              <span className="text-sm font-medium">{j.name}</span>
              <span className="text-muted-foreground ml-auto font-mono text-xs">{j.key}</span>
            </div>
            {j.what ? <p className="text-muted-foreground text-xs">{j.what}</p> : null}
            <p className="text-xs">
              <span className="font-medium">{run ? `Last run ${dot.word}` : "No run reported"}</span>
              {run ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {sydney(run.started)} Sydney · {duration(run.started, run.ended)}
                </span>
              ) : null}
            </p>
            {j.when ? <p className="text-muted-foreground text-xs">{j.when}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
