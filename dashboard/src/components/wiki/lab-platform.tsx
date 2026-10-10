// The Lab platform: what both desks stand on, drawn once and shown on both Engineering wikis. Live parts come from
// the stocks snapshot (it carries the repo's CI runs and the host's deploy record); the rest is written here.
import { Empty } from "@/components/empty";
import { KeyValues } from "@/components/kv";
import { Meter } from "@/components/meter";
import { StatusBadge } from "@/components/status";
import { num, shortSha, sydney, txt } from "@/lib/format";
import { humanize } from "@/lib/labels";
import { list, type Snapshot } from "@/lib/types";
import { ciLanes, diskTone, hostTone, laneTone, stampIso, TONE_VAR, type Lane } from "@/lib/wiki";
import { Diagram, Dot, Edge, EdgeLabel, Figure, Node, T, WikiPart, WikiSection, Why, Zone, type TocGroup } from "./kit";

export const LAB_PLATFORM_TOC: TocGroup = {
  title: "Lab platform",
  items: [
    { id: "ship", label: "How a change ships" },
    { id: "runs", label: "Recent check runs" },
    { id: "publish", label: "What leaves the host" },
    { id: "host", label: "The trading host" },
  ],
};

/** The shared section. `s` is the stocks snapshot, or null when it is missing. */
export function LabPlatform({ s }: { s: Snapshot | null }) {
  const lanes = ciLanes(s?.platform?.runs);
  return (
    <>
      <WikiPart
        id="lab-platform"
        title="Lab platform"
        intro="Shared by both desks and identical on the Stocks and Crypto pages: the road every change takes, what is allowed to leave the host, and the machine the jobs run on."
      />
      <ShipSection s={s} lanes={lanes} />
      <RunsSection lanes={lanes} />
      <PublishSection />
      <HostSection s={s} />
    </>
  );
}

function ShipSection({ s, lanes }: { s: Snapshot | null; lanes: Lane[] }) {
  const id = "dg-ship";
  const required = s?.platform?.required_checks;
  const ci = laneTone(lanes, "ci");
  const site = laneTone(lanes, "dashboard");
  const host = hostTone({ behind: s?.ops?.deployed?.behind, smoke_ok: s?.deploy?.smoke_ok });
  const label = `How a change ships. A branch gets a pull request; the ci workflow runs tests, the ML job and the dashboard gate (last run on main: ${humanize(lanes.find((l) => l.workflow === "ci")?.latestMain?.conclusion ?? "none in the snapshot")}); it is squash-merged to main. Main deploys the site through the dashboard workflow straight away, and reaches the trading host only through the gated deploy (host: ${host.word}).`;
  return (
    <WikiSection
      id="ship"
      eyebrow="Lab platform"
      title="How a change ships"
      lede="One road for every change, then two ways out of main: the site deploys itself, the trading host only when the gate is open."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">The path every change takes.</b> Dots show the newest run of each workflow on
            main and the host&apos;s last deploy; hover a dot for its words. The moving line is code on its way out.
          </>
        }
      >
        <Diagram id={id} w={960} h={330} label={label}>
          <Node x={20} y={34} w={150} h={56} title="Branch" sub={["pre-commit hooks:", "gitleaks, ruff, actionlint"]} />
          <Node
            x={200}
            y={34}
            w={160}
            h={56}
            title="Pull request"
            sub={required === true ? "required checks on" : required === false ? "required checks off" : "review, then checks"}
            dot={
              required === true
                ? { tone: "good", title: "Required checks are on: a red check blocks the merge" }
                : required === false
                  ? { tone: "warn", title: "Required checks are off in this snapshot" }
                  : undefined
            }
          />
          <Zone x={380} y={14} w={270} h={146} label="ci workflow" />
          <Dot cx={630} cy={30} tone={ci} title={`ci on main: ${lanes.find((l) => l.workflow === "ci")?.latestMain?.conclusion ?? "no run in the snapshot"}`} />
          {[
            ["test", "ruff, mypy, pytest"],
            ["ml", "model code"],
            ["dashboard-gate", "lint, tests, e2e"],
          ].map(([t, what], i) => (
            <g key={t}>
              <Node x={392} y={40 + i * 38} w={246} h={30} title={t!} />
              <T x={512} y={59 + i * 38} muted>
                {what}
              </T>
            </g>
          ))}
          <Node x={676} y={34} w={124} h={56} title="main" sub="squash-merge" tone="good" />
          <Node x={830} y={34} w={110} h={56} title="security" sub={["weekly audits,", "CodeQL"]} dashed dot={{ tone: laneTone(lanes, "security"), title: "security workflow on main" }} />
          <Edge diagram={id} d="M170 62 H200" />
          <Edge diagram={id} d="M360 62 H380" />
          <Edge diagram={id} d="M650 62 H676" tone="good" />
          <Edge diagram={id} d="M830 62 H800" dash />

          <T x={20} y={214} caps>
            The site · every merge touching dashboard/
          </T>
          <T x={20} y={232} muted>
            safe to ship any time: it cannot trade
          </T>
          <T x={20} y={286} caps>
            The trading host · only through the gate
          </T>
          <T x={20} y={304} muted>
            never while a job runs or near the session
          </T>
          <Node
            x={470}
            y={196}
            w={200}
            h={52}
            title="dashboard workflow"
            sub="checks, build, deploy, health"
            tone="info"
            dot={{ tone: site, title: `dashboard workflow on main: ${lanes.find((l) => l.workflow === "dashboard")?.latestMain?.conclusion ?? "no run in the snapshot"}` }}
          />
          <Node x={720} y={196} w={220} h={52} title="Vercel · this site" sub="health reports the new commit" />
          <Node x={470} y={268} w={200} h={52} title="wt-deploy (gated)" sub="tag, fast-forward, smoke test" tone="warn" />
          <Node
            x={720}
            y={268}
            w={220}
            h={52}
            title="Trading host"
            sub={host.word}
            dot={{ tone: host.tone, title: `Trading host: ${host.word}` }}
          />
          <Edge diagram={id} d="M738 90 V170 H440 V294 H470" tone="info" flow />
          <Edge diagram={id} d="M440 222 H470" tone="info" flow />
          <Edge diagram={id} d="M670 222 H720" tone="info" flow />
          <Edge diagram={id} d="M670 294 H720" tone="warn" />
          <EdgeLabel x={590} y={166}>
            every merge to main
          </EdgeLabel>
        </Diagram>
      </Figure>
      <Why title="Why two ways out.">
        The site only reads snapshots, so main deploys it straight away. The host runs the trading jobs, so its checkout
        changes only through the gated deploy: outside the trading window, never while a job holds its lock, and always
        with a tag to roll back to.
      </Why>
    </WikiSection>
  );
}

function RunsSection({ lanes }: { lanes: Lane[] }) {
  const id = "dg-runs";
  const X0 = 190;
  const STEP = 25;
  const ROW = 34;
  const max = Math.max(1, ...lanes.map((l) => l.cells.length));
  // A fixed width, so the strip keeps the same scale as the other diagrams however few runs there are.
  const W = Math.max(960, X0 + max * STEP + 20);
  const H = 44 + lanes.length * ROW + 34;
  const total = lanes.reduce((n, l) => n + l.cells.length, 0);
  const failed = lanes.reduce((n, l) => n + l.cells.filter((c) => c.tone === "bad").length, 0);
  return (
    <WikiSection
      id="runs"
      eyebrow="Lab platform"
      title="Recent check runs"
      lede="Every run the snapshot carries, one row per workflow, newest on the right. Solid squares ran on main; faint ones on a branch or pull request."
    >
      {lanes.length === 0 ? (
        <Empty title="No check runs in this snapshot" />
      ) : (
        <Figure
          caption={
            <>
              <b className="text-foreground font-medium">
                {num(total)} runs, {failed === 0 ? "none failed" : `${num(failed)} failed`}.
              </b>{" "}
              Hover a square for its workflow, branch, result and time (Sydney).
            </>
          }
        >
          <Diagram id={id} w={W} h={H} label={`Recent check runs: ${lanes.map((l) => `${l.label} ${l.cells.map((c) => c.conclusion).join(", ")}`).join("; ")}.`}>
            <T x={X0} y={24} caps>
              older
            </T>
            <T x={X0 + max * STEP - 6} y={24} caps anchor="end">
              newer
            </T>
            {lanes.map((l, i) => {
              const y = 44 + i * ROW;
              return (
                <g key={l.workflow}>
                  <T x={20} y={y + 12} weight={500}>
                    {l.label}
                  </T>
                  {l.what ? (
                    <T x={20} y={y + 26} muted size={10.5}>
                      {l.what}
                    </T>
                  ) : null}
                  {l.cells.map((c, j) => (
                    <rect
                      key={j}
                      x={X0 + j * STEP}
                      y={y}
                      width={18}
                      height={18}
                      rx={3}
                      className={c.running ? "wiki-pulse" : undefined}
                      style={{ fill: TONE_VAR[c.tone], fillOpacity: c.main ? 0.95 : 0.3, stroke: TONE_VAR[c.tone] }}
                      strokeWidth={c.main ? 0 : 1}
                    >
                      <title>{`${l.label} · ${c.branch || "unknown branch"} · ${c.conclusion} · ${sydney(c.created)}`}</title>
                    </rect>
                  ))}
                </g>
              );
            })}
            <g transform={`translate(${X0}, ${H - 16})`}>
              <rect x={0} y={-10} width={12} height={12} rx={2} style={{ fill: TONE_VAR.good }} />
              <T x={18} y={0} muted>
                main
              </T>
              <rect x={64} y={-10} width={12} height={12} rx={2} style={{ fill: TONE_VAR.good, fillOpacity: 0.3, stroke: TONE_VAR.good }} />
              <T x={82} y={0} muted>
                branch or PR
              </T>
              <rect x={170} y={-10} width={12} height={12} rx={2} style={{ fill: TONE_VAR.bad }} />
              <T x={188} y={0} muted>
                failed
              </T>
              <rect x={238} y={-10} width={12} height={12} rx={2} style={{ fill: TONE_VAR.info }} />
              <T x={256} y={0} muted>
                running
              </T>
            </g>
          </Diagram>
        </Figure>
      )}
    </WikiSection>
  );
}

function PublishSection() {
  const id = "dg-publish";
  const host = [
    { t: "collect", s: "jobs, journals, state" },
    { t: "allowlist", s: "named, typed fields only" },
    { t: "leak check", s: "8-word overlap test" },
    { t: "schema", s: "generated contract" },
    { t: "sign", s: "HMAC + timestamp" },
  ];
  const site = [
    { t: "/api/ingest", s: "signature, ±5 min" },
    { t: "validate", s: "same schema" },
    { t: "private Blob", s: "only if newer" },
    { t: "these pages", s: "read the latest" },
  ];
  return (
    <WikiSection
      id="publish"
      eyebrow="Lab platform"
      title="What leaves the host"
      lede="A snapshot is the only thing the host sends this site, and every field in it passes the same filters, for both desks."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">Default-deny publishing.</b> A field reaches these pages only if it is named in the
            allowlist; free text is also checked against the private research so none of it can leak. The site checks the
            signature and the schema again before it stores anything.
          </>
        }
      >
        <Diagram
          id={id}
          w={960}
          h={250}
          label="What leaves the host: the collector's output passes an allowlist, a leak check, the schema and an HMAC signature; the site checks the signature and the schema again, stores the snapshot in private Blob only if it is newer, and these pages read the latest one."
        >
          <T x={20} y={26} caps>
            On the host · every 5 to 15 minutes, per desk
          </T>
          {host.map((n, i) => (
            <Node key={n.t} x={20 + i * 188} y={38} w={166} h={52} title={n.t} sub={n.s} tone={i === 2 ? "bad" : i === 1 ? "warn" : undefined} />
          ))}
          {host.slice(1).map((_, i) => (
            <Edge key={i} diagram={id} d={`M${186 + i * 188} 64 H${208 + i * 188}`} tone="info" flow />
          ))}
          <T x={20} y={140} caps>
            On this site
          </T>
          {site.map((n, i) => (
            <Node key={n.t} x={208 + i * 188} y={152} w={166} h={52} title={n.t} sub={n.s} tone={i === 2 ? "info" : undefined} />
          ))}
          {site.slice(1).map((_, i) => (
            <Edge key={i} diagram={id} d={`M${374 + i * 188} 178 H${396 + i * 188}`} tone="info" flow />
          ))}
          <Edge diagram={id} d="M855 90 V120 H291 V152" tone="info" flow />
          <EdgeLabel x={560} y={116}>
            signed POST, retried, never pulled
          </EdgeLabel>
          <T x={20} y={234} muted>
            Anything unknown is dropped on the host; anything that fails a check on the site is refused and the page keeps the last good snapshot.
          </T>
        </Diagram>
      </Figure>
    </WikiSection>
  );
}

function HostSection({ s }: { s: Snapshot | null }) {
  const h = s?.ops?.host;
  const dep = s?.ops?.deployed;
  const d = s?.deploy;
  const checks = list(s?.preflight);
  const passing = checks.filter((c) => c.ok === true).length;
  const disk = diskTone(h?.disk_free_gb, h?.disk_floor_gb, h?.disk_target_gb);
  const host = hostTone({ behind: dep?.behind, smoke_ok: d?.smoke_ok });
  return (
    <WikiSection
      id="host"
      eyebrow="Lab platform"
      title="The trading host"
      lede="The machine both desks' jobs run on, as its last snapshot reported it. The Operations page has the full detail."
    >
      {!s ? (
        <Empty title="The stocks snapshot is missing, so the host has not reported" />
      ) : (
        <div className="bg-card grid gap-4 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={host.tone}>{host.word}</StatusBadge>
            {checks.length > 0 ? (
              <StatusBadge tone={passing === checks.length ? "good" : "warn"}>
                Preflight {passing} of {checks.length} passing
              </StatusBadge>
            ) : null}
          </div>
          <KeyValues
            items={[
              { label: "Running commit", value: shortSha(dep?.head), mono: true },
              { label: "Behind main", value: num(dep?.behind) },
              { label: "Last deploy (Sydney)", value: sydney(stampIso(d?.at)) },
              { label: "Rollback tag", value: txt(d?.rollback_tag), mono: true },
              { label: "Smoke test", value: d?.smoke_ok === true ? "passed" : d?.smoke_ok === false ? "failed" : "—" },
            ]}
          />
          <Meter
            label="Free disk (jobs refuse below the floor)"
            value={h?.disk_free_gb}
            max={h?.disk_total_gb}
            threshold={h?.disk_floor_gb}
            thresholdLabel="floor"
            tone={disk}
            valueText={`${num(h?.disk_free_gb, 1)} GB free, floor ${num(h?.disk_floor_gb, 1)} GB`}
          />
        </div>
      )}
    </WikiSection>
  );
}
