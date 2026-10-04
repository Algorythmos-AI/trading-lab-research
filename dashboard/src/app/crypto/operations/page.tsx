import { CalendarDays, Cog, Timer } from "lucide-react";
import { NoCryptoSnapshot } from "@/components/crypto/panels";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { items, type Crypto } from "@/lib/crypto";
import { duration, num, shortDate, shortSha, sydney } from "@/lib/format";
import { jobTone } from "@/lib/labels";
import { loadCryptoSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crypto operations" };

const JOB: Record<string, string> = { crypto: "Bar cycle", "dashboard-crypto": "Dashboard publish" };

export default async function CryptoOperationsPage() {
  const result = await loadCryptoSnapshot();
  return (
    <>
      <PageHeading
        title="Operations"
        intro="Whether the crypto desk's two jobs are running: the bar cycle after each 15-minute close, and the publish that feeds this page. It runs every day, at every hour."
      />
      {result.status !== "ok" ? (
        <NoCryptoSnapshot status={result.status} />
      ) : (
        <>
          <CyclesPanel s={result.snapshot} />
          <JobsPanel s={result.snapshot} />
          <DailyPanel s={result.snapshot} />
        </>
      )}
    </>
  );
}

function CyclesPanel({ s }: { s: Crypto }) {
  const a = s.activity;
  const short = typeof a?.cycles_24h === "number" && typeof a?.expected_24h === "number" && a.cycles_24h < a.expected_24h * 0.9;
  return (
    <Panel
      title="Bar cycles, last 24 hours"
      icon={Timer}
      means="One cycle should run after every 15-minute bar. A cycle that could not read the venue counts as failed and takes no action."
    >
      <div className="grid gap-4">
        <Meter
          label="Clean cycles"
          value={a?.cycles_24h}
          max={a?.expected_24h}
          tone={short ? "warn" : "good"}
          valueText={`${num(a?.cycles_24h)} of ${num(a?.expected_24h)}`}
        />
        <KeyValues
          items={[
            { label: "Cycles with no data", value: num(a?.failed_24h) },
            { label: "Venue", value: s.config?.venue ?? "—" },
            { label: "Pairs", value: items(s.config?.pairs).join(", ") || "—" },
          ]}
        />
      </div>
    </Panel>
  );
}

function JobsPanel({ s }: { s: Crypto }) {
  const last = Object.entries(s.jobs?.last ?? {});
  return (
    <Panel title="Jobs" icon={Cog} means="The last run of each crypto job on the host, and the code version it ran.">
      {last.length === 0 ? (
        <Empty title="No job has run yet">The crypto jobs are installed on the host in the rollout phase.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Started (Sydney)</TableHead>
              <TableHead className="text-right">Took</TableHead>
              <TableHead>Code</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {last.map(([name, r]) => (
              <TableRow key={name}>
                <TableCell className="font-medium">{JOB[name] ?? name}</TableCell>
                <TableCell>
                  <StatusBadge tone={jobTone(r?.status)}>{r?.status ?? "unknown"}</StatusBadge>
                </TableCell>
                <TableCell>{sydney(r?.started)}</TableCell>
                <TableCell className="text-right font-mono">{duration(r?.started, r?.ended)}</TableCell>
                <TableCell className="font-mono text-xs">{shortSha(r?.sha)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function DailyPanel({ s }: { s: Crypto }) {
  const days = items(s.activity?.daily).slice().reverse();
  return (
    <Panel title="Activity by day" icon={CalendarDays} means="Per UTC day: cycles run, bars observed, and what the desk did. A full day is 96 cycles and 96 bars per pair.">
      {days.length === 0 ? (
        <Empty title="No days recorded yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Cycles</TableHead>
              <TableHead className="text-right">Bars observed</TableHead>
              <TableHead className="text-right">Signals</TableHead>
              <TableHead className="text-right">Entries</TableHead>
              <TableHead className="text-right">Exits</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((d) => (
              <TableRow key={d.day}>
                <TableCell>{shortDate(d.day)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.cycles)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.observations)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.fires)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.entries)}</TableCell>
                <TableCell className="text-right font-mono">{num(d.exits)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
