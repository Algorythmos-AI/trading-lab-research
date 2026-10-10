import { BookOpen, BrainCircuit, FlaskConical, Layers, Scale, Target } from "lucide-react";
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { NoSnapshot } from "@/components/no-snapshot";
import { PageHeading } from "@/components/page-heading";
import { Panel } from "@/components/panel";
import { Scoreboard } from "@/components/scoreboard";
import { SpecBars } from "@/components/spec-bars";
import { StatusBadge } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { num, pct, shortDate, txt } from "@/lib/format";
import { humanize, stateTone, type Tone } from "@/lib/labels";
import { loadSnapshot } from "@/lib/snapshot";
import { entries, list, type Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Research" };

export default async function ResearchPage() {
  const result = await loadSnapshot();
  return (
    <>
      <PageHeading
        title="Research"
        intro="The evidence behind every strategy decision: backtest results against the G1 bar, the trial budget, the research registries and how much of the specification is built."
      />
      {result.status !== "ok" ? (
        <NoSnapshot status={result.status} />
      ) : (
        <>
          <ScoreboardPanel s={result.snapshot} />
          <div className="grid gap-5 lg:grid-cols-2">
            <BudgetPanel s={result.snapshot} />
            <Cat01Panel s={result.snapshot} />
          </div>
          <RegistriesPanel s={result.snapshot} />
          <SpecPanel s={result.snapshot} />
          <NoModelPanel />
        </>
      )}
    </>
  );
}

/** So that nothing is left to guess: the stocks desk has no learned model. */
function NoModelPanel() {
  return (
    <Panel title="Machine learning" icon={BrainCircuit} means="Whether any learned model takes part in this desk's decisions.">
      <Empty title="No learned model on this desk">
        Every stocks rule is written out by hand; the catalyst check is a fixed word list, not a trained model. The only model in the lab scores
        the crypto desk&apos;s signals, on that desk&apos;s Machine learning page.
      </Empty>
    </Panel>
  );
}

function ScoreboardPanel({ s }: { s: Snapshot }) {
  const rows = list(s.research?.scoreboard);
  return (
    <Panel
      title="G1 scoreboard"
      icon={Scale}
      means="Backtest results for every candidate. A real edge needs the whole bar (the 95% range of average R per trade) right of zero and a deflated Sharpe (DSR) of at least 0.95."
    >
      {rows.length === 0 ? <Empty title="No backtest results in this snapshot" /> : <Scoreboard rows={rows} />}
    </Panel>
  );
}

function BudgetPanel({ s }: { s: Snapshot }) {
  const t = s.research?.trials;
  const used = t?.used;
  const budget = t?.budget_if_round3;
  const tone: Tone =
    typeof used === "number" && typeof budget === "number" ? (used >= budget ? "bad" : used / budget >= 0.9 ? "warn" : "info") : "neutral";
  return (
    <Panel
      title="Trial budget"
      icon={FlaskConical}
      means="Every strategy variant tested counts as a trial. More trials make a lucky result more likely, so the budget is capped and the bar for G1 rises with each one."
    >
      <div className="grid gap-4">
        <Meter
          label="Trials used"
          value={used}
          max={budget}
          tone={tone}
          valueText={`${num(used)} of ${num(budget)}`}
        />
        <KeyValues
          items={[
            { label: "DEC-0010", value: txt(s.research?.dec0010_status) },
            { label: "Active strategies", value: num(list(s.research?.active_strategies).length) },
            { label: "Lessons recorded", value: num(s.research?.lessons_count) },
          ]}
        />
        {list(s.research?.active_strategies).length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {list(s.research?.active_strategies).map((a) => (
              <li key={a} className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                {a}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}

function Cat01Panel({ s }: { s: Snapshot }) {
  const c = s.research?.cat01;
  const passed = c?.passed;
  return (
    <Panel
      title="CAT-01 catalyst accuracy"
      icon={Target}
      means="How often the automatic news-catalyst label agreed with your own verdicts. It has to reach the target before catalysts can be trusted in a strategy."
      action={
        passed === true ? (
          <StatusBadge tone="good">Passed</StatusBadge>
        ) : passed === false ? (
          <StatusBadge tone="warn">Below target</StatusBadge>
        ) : null
      }
    >
      <div className="grid gap-4">
        <Meter
          label="Accuracy"
          value={c?.accuracy_pct}
          max={100}
          tone={passed ? "good" : "warn"}
          threshold={c?.target_pct}
          thresholdLabel={typeof c?.target_pct === "number" ? `Target ${pct(c.target_pct, 0)} (marked)` : undefined}
          valueText={pct(c?.accuracy_pct, 1)}
        />
        <Meter
          label="Your verdicts"
          value={c?.verdicts_done}
          max={c?.verdicts_total}
          tone="info"
          valueText={`${num(c?.verdicts_done)} of ${num(c?.verdicts_total)}`}
        />
      </div>
    </Panel>
  );
}

function RegistriesPanel({ s }: { s: Snapshot }) {
  const decisions = list(s.research?.decisions);
  const hypotheses = list(s.research?.hypotheses);
  const round3 = list(s.research?.round3);
  return (
    <Panel
      title="Research registries"
      icon={BookOpen}
      means="The decision, hypothesis and round-3 records, by ID and status only. Their wording stays private; open the repository to read them."
    >
      <div className="grid gap-6 md:grid-cols-3">
        <Registry
          caption="Decisions"
          empty="No decisions recorded."
          head={["ID", "Status", "Date"]}
          rows={decisions.map((d) => [d.id, d.status, shortDate(d.date)])}
        />
        <Registry
          caption="Hypotheses"
          empty="No hypotheses registered."
          head={["ID", "Status"]}
          rows={hypotheses.map((h) => [h.id, h.status])}
        />
        <Registry
          caption="Round 3"
          empty="No round-3 trials registered."
          head={["ID", "Set", "Status"]}
          rows={round3.map((r) => [r.id, r.set, r.hyp_status])}
        />
      </div>
    </Panel>
  );
}

function Registry({
  caption,
  head,
  rows,
  empty,
}: {
  caption: string;
  head: string[];
  rows: (string | null | undefined)[][];
  empty: string;
}) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1 text-sm font-medium">
        {caption} <span className="text-muted-foreground font-normal">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">{empty}</p>
      ) : (
        <div
          // A scrolling list must be reachable by keyboard, or its lower rows cannot be read without a mouse.
          role="region"
          aria-label={caption}
          tabIndex={0}
          className="focus-visible:ring-ring/60 max-h-80 overflow-y-auto rounded-md outline-none focus-visible:ring-2"
        >
          <Table>
            <TableHeader>
              <TableRow>
                {head.map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r[0]}-${i}`}>
                  {r.map((cell, j) =>
                    j === 0 ? (
                      <TableCell key={j} className="font-mono text-xs">
                        {txt(cell)}
                      </TableCell>
                    ) : head[j] === "Status" ? (
                      <TableCell key={j} className="whitespace-normal">
                        <StatusBadge tone={registryTone(cell)} className="whitespace-normal">
                          {humanize(cell)}
                        </StatusBadge>
                      </TableCell>
                    ) : (
                      <TableCell key={j}>{txt(cell)}</TableCell>
                    ),
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function registryTone(status: string | null | undefined): Tone {
  const s = String(status ?? "").toLowerCase();
  if (s.includes("effect") || s.includes("accepted") || s.includes("confirmed")) return "good";
  if (s.includes("reject") || s.includes("falsified") || s.includes("superseded")) return "neutral";
  if (s.includes("pre-registered") || s.includes("running") || s.includes("proposed")) return "info";
  return stateTone(status);
}

function SpecPanel({ s }: { s: Snapshot }) {
  const spec = s.spec;
  const areas = list(spec?.by_area);
  const byStatus = entries(spec?.by_status);
  const byLevel = entries(spec?.by_level);
  const implemented = spec?.by_status?.implemented;
  return (
    <Panel
      title="Specification coverage"
      icon={Layers}
      means="How many requirements of the approved specification are built, by area. Not applicable items are excluded by design; needs-data items wait on a data source."
      action={
        spec?.status ? <StatusBadge tone={stateTone(spec.status === "approved" ? "done" : spec.status)}>{humanize(spec.status)}</StatusBadge> : null
      }
    >
      <div className="grid gap-5">
        <KeyValues
          items={[
            { label: "Specification", value: `${txt(spec?.spec_id)} v${txt(spec?.version)}`, mono: true },
            { label: "Requirements", value: num(spec?.total) },
            {
              label: "Implemented",
              value:
                typeof implemented === "number" && typeof spec?.total === "number" && spec.total > 0
                  ? `${num(implemented)} (${pct((implemented / spec.total) * 100, 0)})`
                  : num(implemented),
            },
            ...byStatus
              .filter(([k]) => k !== "implemented")
              .map(([k, v]) => ({ label: humanize(k === "n_a" ? "not applicable" : k), value: num(v) })),
            ...byLevel.map(([k, v]) => ({ label: `${k} level`, value: num(v) })),
          ]}
        />
        {areas.length === 0 ? <Empty title="No per-area breakdown in this snapshot" /> : <SpecBars areas={areas} />}
      </div>
    </Panel>
  );
}
