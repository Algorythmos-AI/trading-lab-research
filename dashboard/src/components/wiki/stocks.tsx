// The stocks desk's Engineering wiki: how the desk is built, drawn as pictures whose dots come from the stocks
// snapshot. Software only: no spec text, setup names or decision prose (the repo is restricted); gates and
// decisions appear by id, name and status.
import { StatusBadge } from "@/components/status";
import { num, shortSha, txt } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { entries, list, type Snapshot } from "@/lib/types";
import { ciLanes, currentGate, gateTone, jobDot, jobsHealthy, nyMinutes, sydneyAheadOfNy, TONE_VAR } from "@/lib/wiki";
import { Diagram, Dot, Edge, EdgeLabel, Figure, Node, T, WikiSection, Why, Zone, type TocGroup } from "./kit";

export const STOCKS_TOC: TocGroup = {
  title: "Stocks desk",
  items: [
    { id: "glance", label: "At a glance" },
    { id: "architecture", label: "Architecture" },
    { id: "night", label: "A trading night" },
    { id: "orders", label: "Order safety" },
    { id: "gates", label: "Research gates" },
    { id: "plans", label: "Plans and history" },
    { id: "runbooks", label: "Runbooks and decisions" },
  ],
};

const JOBS: { key: string; name: string; when: string }[] = [
  { key: "routine", name: "routine", when: "07:30 ET" },
  { key: "paper-b", name: "paper-b", when: "08:30 ET" },
  { key: "forward", name: "forward", when: "12:40 ET" },
  { key: "weekly", name: "weekly", when: "Fri 20:00 ET" },
  { key: "dashboard", name: "dashboard", when: "every 5 min" },
];

const TILE_TEXT: Record<Tone, string> = { good: "text-good", warn: "text-warn", bad: "text-bad", info: "text-info", neutral: "text-foreground" };

function Tile({ label, value, sub, tone, className = "" }: { label: string; value: string; sub?: string; tone: Tone; className?: string }) {
  return (
    <li className={`bg-card grid min-w-0 gap-0.5 rounded-lg border px-3.5 py-3 ${className}`}>
      <span className="text-muted-foreground text-[0.6875rem] tracking-wider uppercase">{label}</span>
      <span className={`text-base font-semibold ${TILE_TEXT[tone]}`}>{value}</span>
      {sub ? <span className="text-muted-foreground truncate text-xs">{sub}</span> : null}
    </li>
  );
}

export function GlanceSection({ s }: { s: Snapshot }) {
  const last = entries(s.jobs?.last);
  const jobs = jobsHealthy(last.map(([, r]) => r));
  const failed = last.filter(([, r]) => jobDot(r).tone !== "good").map(([k]) => k);
  const latched = s.ops?.paper?.virtual?.latched === true;
  const kill = s.kill?.on === true;
  const gate = currentGate(list(s.overview?.gates));
  const dep = s.ops?.deployed;
  const lanes = ciLanes(s.platform?.runs);
  const ci = lanes.find((l) => l.workflow === "ci")?.latestMain;
  return (
    <WikiSection id="glance" eyebrow="Stocks desk" title="At a glance" lede="Is the machine healthy? Five answers before anything else, from the latest snapshot.">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="The stocks desk at a glance">
        <Tile
          label="Last runs"
          value={jobs.total ? `${jobs.ok} of ${jobs.total} ok` : "—"}
          sub={failed.length ? `needs a look: ${failed.join(", ")}` : "every job's last run ended well"}
          tone={jobs.tone}
        />
        <Tile
          label="Entries"
          value={latched ? "Latched" : kill ? "Kill switch on" : "Allowed"}
          sub={latched || kill ? "exits are still managed" : "guards clear"}
          tone={latched ? "bad" : kill ? "warn" : "good"}
        />
        <Tile
          label="Research gate"
          value={gate ? `${txt(gate.id)} · ${txt(gate.name)}` : "All passed"}
          sub={gate ? (gate.progress ?? gate.status?.replace(/_/g, " ") ?? undefined) : undefined}
          tone={gate ? gateTone(gate.status) : "good"}
        />
        <Tile
          label="Running commit"
          value={shortSha(dep?.head)}
          sub={typeof dep?.behind === "number" ? (dep.behind === 0 ? "level with main" : `${dep.behind} behind main`) : undefined}
          tone={typeof dep?.behind === "number" && dep.behind > 0 ? "warn" : "neutral"}
        />
        <Tile
          className="col-span-2 sm:col-span-1"
          label="Checks on main" value={ci ? ci.conclusion : "—"} sub={ci ? "newest ci run" : "no ci run in the snapshot"} tone={ci ? ci.tone : "neutral"} />
      </ul>
    </WikiSection>
  );
}

export function ArchitectureSection({ s }: { s: Snapshot }) {
  const id = "dg-arch";
  const last = new Map(entries(s.jobs?.last));
  const dots = JOBS.map((j) => ({ ...j, dot: jobDot(last.get(j.key)) }));
  const label = `Architecture of the stocks desk. Alpaca's paper account supplies bars and quotes and takes paper orders; nothing else can trade. On the host, systemd timers start five jobs through one job runner: ${dots
    .map((j) => `${j.name} (last run ${j.dot.word})`)
    .join(", ")}. They write a hash-chained paper journal, the forward ledger and runtime state; the publisher sends a filtered, signed snapshot to this site and alerts go to ntfy.`;
  return (
    <WikiSection
      id="architecture"
      eyebrow="Stocks desk"
      title="Architecture"
      lede="One broker on the left, one host in the middle, this site on the right. Every job enters through the same runner."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">The stocks desk, high level.</b> Each job&apos;s dot is its last run; hover it for the
            word. The red line is the paper-only wall: the broker adapter hard-codes Alpaca&apos;s paper endpoint.
          </>
        }
      >
        <Diagram id={id} w={980} h={390} label={label}>
          <T x={20} y={30} caps>
            Broker
          </T>
          <Node x={20} y={150} w={170} h={80} title="Alpaca (paper)" sub={["bars and quotes in,", "paper orders out", "nothing else trades"]} tone="info" />
          <line x1={212} y1={30} x2={212} y2={370} style={{ stroke: "var(--bad-fill)" }} strokeWidth={2} strokeDasharray="8 5" />
          <T x={20} y={290} muted>
            paper only: no live keys,
          </T>
          <T x={20} y={305} muted>
            the adapter is locked to paper
          </T>
          <Zone x={230} y={14} w={530} h={366} label="Trading host" />
          <Node x={244} y={40} w={502} h={32} title="systemd timers · New York time, from one JOBS table" />
          <Node x={244} y={90} w={502} h={32} title="job runner · lock, preflight, deadline, heartbeat, alerts" tone="info" />
          {dots.map((j, i) => (
            <Node
              key={j.key}
              x={244 + i * 102}
              y={146}
              w={94}
              h={52}
              title={j.name}
              sub={j.when}
              dot={{ tone: j.dot.tone, pulse: j.dot.pulse, title: `${j.name}: last run ${j.dot.word}` }}
            />
          ))}
          <Node x={244} y={236} w={162} h={46} title="paper journal" sub="hash-chained" />
          <Node x={414} y={236} w={162} h={46} title="forward ledger" sub="hash-chained" />
          <Node x={584} y={236} w={162} h={46} title="runtime state" sub="var/, outside git" />
          <Node x={244} y={318} w={502} h={44} title="publisher · allowlist, leak check, schema, signature" sub={undefined} tone="info" />
          <Edge diagram={id} d="M495 72 V90" />
          <Edge diagram={id} d="M495 122 V146" />
          <Edge diagram={id} d="M495 198 V236" />
          <Edge diagram={id} d="M495 282 V318" />
          <Edge diagram={id} d="M190 172 H244" tone="info" flow />
          <Edge diagram={id} d="M244 208 H190" tone="good" />
          <EdgeLabel x={221} y={164}>
            data
          </EdgeLabel>
          <EdgeLabel x={221} y={222}>
            orders
          </EdgeLabel>
          <T x={790} y={30} caps>
            Outside the host
          </T>
          <Node x={790} y={90} w={174} h={52} title="ntfy + healthchecks" sub="pages Sam's phone" tone="warn" />
          <Node x={790} y={310} w={174} h={52} title="This site" sub="Vercel, read-only" tone="info" />
          <Edge diagram={id} d="M746 106 H790" tone="warn" />
          <Edge diagram={id} d="M746 340 H790" tone="info" flow />
        </Diagram>
      </Figure>
      <Why title="Why one runner.">
        Locks, preflight, deadlines and heartbeats are written once and shared by every job on both desks. A job that
        cannot run safely refuses (a quiet, paged outcome) instead of half-running.
      </Why>
    </WikiSection>
  );
}

export function NightSection({ s, now }: { s: Snapshot; now: Date }) {
  const id = "dg-night";
  const X0 = 120;
  const HR = 78;
  const x = (min: number) => X0 + ((min - 7 * 60) / 60) * HR;
  const at = (h: number, m = 0) => x(h * 60 + m);
  const last = new Map(entries(s.jobs?.last));
  const nowMin = nyMinutes(now);
  const showNow = nowMin >= 7 * 60 && nowMin <= 17 * 60;
  const syd = sydneyAheadOfNy(now);
  const lanes = [
    { key: "routine", y: 56 },
    { key: "paper-b", y: 108 },
    { key: "forward", y: 160 },
    { key: "dashboard", y: 212 },
  ];
  const hours = Array.from({ length: 11 }, (_, i) => 7 + i);
  const label = `One trading night in New York time, 07:00 to 17:00, with Sydney time underneath. The routine scans before the open; paper B starts at 08:30, trades the cash session from 09:30 and is flat by the close; the forward test starts at 12:40 and scores after the close; the dashboard publishes every 5 minutes.${
    showNow ? ` Now is ${Math.floor(nowMin / 60)}:${String(nowMin % 60).padStart(2, "0")} New York.` : ""
  }`;
  const hhmm = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return (
    <WikiSection
      id="night"
      eyebrow="Stocks desk"
      title="A trading night"
      lede="Every job starts at a fixed New York time and waits inside its process for the exact moment it needs, so daylight saving needs no edits."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">The night on both clocks.</b> Grey is a job waiting, colour is work, the blue band is the
            US cash session. {showNow ? "The dashed line is now." : "Outside these hours the line for now is hidden."}
          </>
        }
      >
        <Diagram id={id} w={960} h={300} label={label}>
          <rect x={at(9, 30)} y={34} width={at(16) - at(9, 30)} height={210} style={{ fill: "var(--info-soft)" }} />
          <T x={at(12, 45)} y={28} muted anchor="middle">
            cash session 09:30–16:00
          </T>
          {hours.map((h) => (
            <g key={h}>
              <line x1={at(h)} y1={34} x2={at(h)} y2={244} style={{ stroke: "var(--chart-grid)" }} />
              <T x={at(h)} y={262} mono muted anchor="middle">
                {`${String(h).padStart(2, "0")}:00`}
              </T>
              {h % 2 === 1 ? (
                <T x={at(h)} y={284} mono muted anchor="middle">
                  {hhmm(h * 60 + syd)}
                </T>
              ) : null}
            </g>
          ))}
          <T x={20} y={262} caps>
            New York
          </T>
          <T x={20} y={284} caps>
            Sydney
          </T>
          {lanes.map((l) => {
            const d = jobDot(last.get(l.key));
            return (
              <g key={l.key}>
                <Dot cx={24} cy={l.y + 12} tone={d.tone} pulse={d.pulse} title={`${l.key}: last run ${d.word}`} />
                <T x={36} y={l.y + 16}>
                  {l.key}
                </T>
              </g>
            );
          })}
          {/* routine: starts 07:30, scans and plans until its 09:15 hand-off */}
          <rect x={at(7, 30)} y={56} width={at(7, 55) - at(7, 30)} height={24} rx={4} style={{ fill: "var(--muted)", stroke: "var(--border)" }} />
          <rect x={at(7, 55)} y={56} width={at(9, 15) - at(7, 55)} height={24} rx={4} style={{ fill: "var(--good-soft)", stroke: "var(--good-fill)" }} />
          <T x={at(9, 15) + 8} y={72} muted>
            waits to 07:55, then scans, ranks and plans
          </T>
          {/* paper B */}
          <rect x={at(8, 30)} y={108} width={at(9, 30) - at(8, 30)} height={24} rx={4} style={{ fill: "var(--muted)", stroke: "var(--border)" }} />
          <T x={at(8, 30) + 6} y={124} muted>
            arms
          </T>
          <rect x={at(9, 30)} y={108} width={at(16) - at(9, 30)} height={24} rx={4} style={{ fill: "var(--good-soft)", stroke: "var(--good-fill)" }} />
          <T x={at(9, 30) + 8} y={124}>
            one plan at a time, server-side stop from the first fill, flat by the close
          </T>
          {/* forward */}
          <rect x={at(12, 40)} y={160} width={at(16, 20) - at(12, 40)} height={24} rx={4} style={{ fill: "var(--muted)", stroke: "var(--border)" }} />
          <T x={at(12, 40) + 8} y={176} muted>
            starts 12:40, waits for close + 20 min
          </T>
          <rect x={at(16, 20)} y={160} width={at(17) - at(16, 20)} height={24} rx={4} style={{ fill: "var(--info-soft)", stroke: "var(--info-fill)" }} />
          <T x={at(16, 20) + 6} y={176}>
            scores
          </T>
          {/* dashboard ticks */}
          {Array.from({ length: 121 }, (_, k) => (
            <rect key={k} x={at(7) + (k * HR) / 12 - 0.8} y={212} width={1.6} height={22} style={{ fill: "var(--good-fill)", opacity: 0.8 }} />
          ))}
          {showNow ? (
            <g>
              <line x1={x(nowMin)} y1={34} x2={x(nowMin)} y2={244} style={{ stroke: "var(--info-fill)" }} strokeWidth={1.5} strokeDasharray="3 3" />
              <T x={x(nowMin) + 4} y={46} size={11}>
                now
              </T>
            </g>
          ) : null}
        </Diagram>
      </Figure>
      <Why title="Why the order matters.">
        The routine&apos;s plan must exist before paper B can act at the open, and the forward test waits until 20 minutes after
        the close so the free data feed&apos;s delay has passed. The weekly scorecard runs on Friday evening, after the
        forward test releases its lock.
      </Why>
    </WikiSection>
  );
}

const GUARDS: { name: string; entryOnly: boolean }[] = [
  { name: "paper lock", entryOnly: false },
  { name: "symbol allowlist", entryOnly: false },
  { name: "sell within long position", entryOnly: false },
  { name: "quantity and notional caps", entryOnly: false },
  { name: "kill switch off", entryOnly: true },
  { name: "loss latch clear", entryOnly: true },
  { name: "market open", entryOnly: true },
  { name: "entries and orders per day", entryOnly: true },
  { name: "flat, no duplicate order", entryOnly: true },
];

export function OrdersSection({ s }: { s: Snapshot }) {
  const id = "dg-orders";
  const kill = s.kill?.on === true;
  const latched = s.ops?.paper?.virtual?.latched === true;
  const live: Record<string, { tone: Tone; word: string }> = {
    "kill switch off": kill ? { tone: "warn", word: "kill switch is ON: entries refused" } : { tone: "good", word: "kill switch off" },
    "loss latch clear": latched ? { tone: "bad", word: "loss latch is SET: entries refused" } : { tone: "good", word: "loss latch clear" },
  };
  const states: { k: string; x: number; y: number; tone?: Tone }[] = [
    { k: "planned", x: 380, y: 52 },
    { k: "submitting", x: 560, y: 52 },
    { k: "entry working", x: 740, y: 52 },
    { k: "in position", x: 740, y: 150, tone: "good" },
    { k: "exiting", x: 560, y: 150 },
    { k: "closed", x: 380, y: 150, tone: "good" },
    { k: "aborted", x: 650, y: 248, tone: "bad" },
  ];
  return (
    <WikiSection
      id="orders"
      eyebrow="Stocks desk"
      title="Order safety"
      lede="Every order passes the pre-trade guard, and every plan moves through one small state machine that survives a restart."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">The guard and the plan.</b> Starred checks apply to entries only; exits and stops skip
            them, so a risk-reducing order always gets through. The kill switch and latch dots are live.
          </>
        }
      >
        <Diagram
          id={id}
          w={960}
          h={330}
          label={`Order safety. Every order passes the pre-trade guard: ${GUARDS.map((g) => g.name).join(", ")}. Kill switch ${kill ? "on" : "off"}, loss latch ${latched ? "set" : "clear"}. A plan moves planned, submitting, entry working, in position, exiting, closed; an entry that never fills is aborted.`}
        >
          <Zone x={20} y={14} w={320} h={300} label="Pre-trade guard" />
          {GUARDS.map((g, i) => {
            const l = live[g.name];
            return (
              <g key={g.name}>
                <Dot cx={42} cy={58 + i * 28} tone={l?.tone ?? "neutral"} title={l?.word ?? `${g.name}: checked on every ${g.entryOnly ? "entry" : "order"}`} r={4} />
                <T x={56} y={62 + i * 28}>
                  {`${g.name}${g.entryOnly ? " *" : ""}`}
                </T>
              </g>
            );
          })}
          <Edge diagram={id} d="M340 72 H380" tone="good" />
          {states.map((st) => (
            <g key={st.k}>
              <rect
                x={st.x}
                y={st.y}
                width={140}
                height={40}
                rx={20}
                style={{
                  fill: st.tone ? `color-mix(in srgb, ${TONE_VAR[st.tone]} 12%, var(--card))` : "var(--card)",
                  stroke: st.tone ? TONE_VAR[st.tone] : "var(--border)",
                }}
              />
              <T x={st.x + 70} y={st.y + 25} anchor="middle">
                {st.k}
              </T>
            </g>
          ))}
          <Edge diagram={id} d="M520 72 H560" />
          <Edge diagram={id} d="M700 72 H740" />
          <Edge diagram={id} d="M850 92 V150" tone="good" />
          <EdgeLabel x={858} y={126} anchor="start">
            first fill
          </EdgeLabel>
          <Edge diagram={id} d="M740 170 H700" />
          <Edge diagram={id} d="M560 170 H520" tone="good" />
          <Edge diagram={id} d="M630 92 C 630 190, 700 200, 712 248" tone="bad" dash />
          <Edge diagram={id} d="M770 92 C 780 190, 760 220, 742 248" tone="bad" dash />
          <EdgeLabel x={700} y={232}>
            no fill, or refused
          </EdgeLabel>
          <T x={380} y={226} muted>
            Every transition is saved, so a restart
          </T>
          <T x={380} y={241} muted>
            resumes the plan instead of re-entering.
          </T>
          <T x={380} y={290} muted>
            A server-side GTC stop rests at the broker from the first fill;
          </T>
          <T x={380} y={305} muted>
            an exit cancels it, confirms the cancel, then sells.
          </T>
        </Diagram>
      </Figure>
      <div className="flex flex-wrap gap-2">
        <StatusBadge tone={kill ? "warn" : "good"}>{kill ? "Kill switch on: entries refused" : "Kill switch off"}</StatusBadge>
        <StatusBadge tone={latched ? "bad" : "good"}>{latched ? "Loss latch set" : "Loss latch clear"}</StatusBadge>
      </div>
      <Why title="Why the broker is the source of truth.">
        Each order has its own client id, so after a timeout it is found by id rather than sent twice. Reconciliation
        protects any unprotected position and cancels this strategy&apos;s stray orders, never another&apos;s.
      </Why>
    </WikiSection>
  );
}

export function GatesSection({ s }: { s: Snapshot }) {
  const id = "dg-gates";
  const gates = list(s.overview?.gates);
  if (gates.length === 0) return null;
  const X0 = 80;
  const step = Math.min(130, 800 / Math.max(1, gates.length - 1));
  const cur = currentGate(gates);
  return (
    <WikiSection
      id="gates"
      eyebrow="Stocks desk"
      title="Research gates"
      lede="A strategy reaches real money only by clearing each gate in order. The current gate is ringed; the Research page has the evidence."
    >
      <Figure caption={<><b className="text-foreground font-medium">The gate rail.</b> Green passed, red failed, blue in progress, grey not started.</>}>
        <Diagram
          id={id}
          w={960}
          h={170}
          label={`Research gates: ${gates.map((g) => `${g.id} ${g.name} ${String(g.status ?? "").replace(/_/g, " ")}${g.progress ? ` (${g.progress})` : ""}`).join("; ")}.`}
        >
          <line x1={X0} y1={56} x2={X0 + step * (gates.length - 1)} y2={56} style={{ stroke: "var(--border)" }} strokeWidth={2} />
          {gates.map((g, i) => {
            const cx = X0 + i * step;
            const tone = gateTone(g.status);
            const isCur = cur?.id === g.id;
            return (
              <g key={`${g.id}-${i}`}>
                {isCur ? <circle cx={cx} cy={56} r={17} className="wiki-pulse" style={{ fill: "none", stroke: TONE_VAR[tone] }} strokeWidth={2} /> : null}
                <circle cx={cx} cy={56} r={11} style={{ fill: TONE_VAR[tone] }}>
                  <title>{`${g.id} ${g.name}: ${String(g.status ?? "").replace(/_/g, " ")}`}</title>
                </circle>
                <T x={cx} y={98} anchor="middle" weight={600}>
                  {txt(g.id)}
                </T>
                <T x={cx} y={116} anchor="middle" muted>
                  {txt(g.name)}
                </T>
                <T x={cx} y={134} anchor="middle" muted size={10.5}>
                  {String(g.status ?? "").replace(/_/g, " ")}
                </T>
                {g.progress ? (
                  <T x={cx} y={152} anchor="middle" size={10.5}>
                    {g.progress}
                  </T>
                ) : null}
              </g>
            );
          })}
        </Diagram>
      </Figure>
    </WikiSection>
  );
}

const ADRS = [
  { id: "0001", title: "Dashboard on Vercel, fed by a signed push", status: "accepted" },
  { id: "0002", title: "Runtime state outside git, computed deploy gate", status: "accepted" },
  { id: "0004", title: "Trading host on an OCI Always Free VM", status: "proposed" },
  { id: "0005", title: "Desks: stocks and crypto", status: "accepted" },
];

const RUNBOOKS: { file: string; when: string }[] = [
  { file: "not-flat-at-close", when: "p5 “Paper B NOT FLAT at the close”, a red banner" },
  { file: "position-alerts", when: "“adopted a position”, “exits only”, “clock check failed”" },
  { file: "latch-reset", when: "p5 “loss limit latched”; entries stay off" },
  { file: "kill-and-flatten", when: "you want trading to stop now" },
  { file: "rollback", when: "the next night's jobs fail after a deploy" },
  { file: "disk-full", when: "p3 “refused to run: free disk”" },
  { file: "dead-man-switches", when: "a healthchecks.io page" },
  { file: "backups-and-lease", when: "“evidence chain broken”, “no primary lease”" },
  { file: "dashboard-late", when: "“Dashboard late”, a grey or amber freshness pill" },
  { file: "secret-rotation", when: "a secret may have leaked" },
];

export function RunbooksSection() {
  return (
    <WikiSection
      id="runbooks"
      eyebrow="Stocks desk"
      title="Runbooks and decisions"
      lede="What to open when something pages, and the architecture decisions the design rests on. Both live in the repo's docs/ folder."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="bg-card rounded-lg border p-4">
          <p className="text-muted-foreground mb-2 text-[0.6875rem] tracking-wider uppercase">You see → open</p>
          <ul className="grid gap-1.5 text-sm">
            {RUNBOOKS.map((r) => (
              <li key={r.file} className="flex flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 flex-1">{r.when}</span>
                <span className="text-muted-foreground font-mono text-xs">docs/runbooks/{r.file}.md</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-card rounded-lg border p-4">
          <p className="text-muted-foreground mb-2 text-[0.6875rem] tracking-wider uppercase">Architecture decisions</p>
          <ul className="grid gap-2 text-sm">
            {ADRS.map((a) => (
              <li key={a.id} className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-semibold">ADR {a.id}</span>
                <span className="min-w-0 flex-1">{a.title}</span>
                <StatusBadge tone={a.status === "accepted" ? "good" : "warn"}>{a.status}</StatusBadge>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {num(RUNBOOKS.length)} of the runbooks most likely at 3 a.m.; the full index is docs/runbooks/README.md.
      </p>
    </WikiSection>
  );
}

