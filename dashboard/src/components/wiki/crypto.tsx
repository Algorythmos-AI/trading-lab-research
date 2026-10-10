// The crypto desk's Engineering wiki: how the desk is built, drawn as pictures whose dots come from the crypto
// snapshot. Software only: books, challengers and gates appear by name, id and status, never by their rules.
import { Meter } from "@/components/meter";
import { items, plural, type Crypto } from "@/lib/crypto";
import { num } from "@/lib/format";
import type { Tone } from "@/lib/labels";
import { entries } from "@/lib/types";
import { jobDot, modelTone, TONE_VAR, utcAheadOfNy, zoneMinutes } from "@/lib/wiki";
import { Diagram, Dot, Edge, EdgeLabel, Figure, Node, T, WikiSection, Why, Zone, type TocGroup } from "./kit";

export const CRYPTO_TOC: TocGroup = {
  title: "Crypto desk",
  items: [
    { id: "glance", label: "At a glance" },
    { id: "architecture", label: "Architecture" },
    { id: "cycle", label: "The bar cycle" },
    { id: "clock", label: "Around the clock" },
    { id: "limits", label: "Risk limits" },
    { id: "learning", label: "The learning loop" },
    { id: "challengers", label: "Challengers and gates" },
    { id: "jobs", label: "The desk's jobs" },
    { id: "controls", label: "Owner controls" },
  ],
};

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

/** The model lineage in force, if any. */
const inForce = (s: Crypto) => items(s.learning?.lineages).find((l) => l.in_force) ?? null;

/** Every paper book the snapshot names: the baseline first, then the sleeves and live challengers. */
function books(s: Crypto): { name: string; stage: string | null; latched: boolean; challenger: boolean }[] {
  return [
    { name: "baseline", stage: null, latched: s.risk?.latched === true, challenger: false },
    ...items(s.sleeves).map((b) => ({
      name: b.name ?? "?",
      stage: b.stage ?? null,
      latched: b.latched === true,
      challenger: (b.name ?? "").startsWith("ch-"),
    })),
  ];
}

export function GlanceSection({ s }: { s: Crypto }) {
  const a = s.activity;
  const cycles = a?.cycles_24h;
  const expected = a?.expected_24h;
  const failed = a?.failed_24h ?? 0;
  const kill = s.kill?.on === true;
  const latched = s.risk?.latched === true || items(s.sleeves).some((b) => b.latched);
  const chain = s.risk?.chain_ok !== false;
  const lin = inForce(s);
  const ch = s.challengers;
  const bk = books(s);
  return (
    <WikiSection id="glance" eyebrow="Crypto desk" title="At a glance" lede="Is the desk running and allowed to trade? Five answers from the latest crypto snapshot.">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="The crypto desk at a glance">
        <Tile
          label="Bar cycles, 24 h"
          value={typeof cycles === "number" ? `${num(cycles)} of ${num(expected)}` : "—"}
          sub={failed > 0 ? `${num(failed)} failed` : "none failed"}
          tone={typeof cycles !== "number" ? "neutral" : failed > 0 || (typeof expected === "number" && cycles < expected - 2) ? "warn" : "good"}
        />
        <Tile
          label="Entries"
          value={!chain ? "Chain broken" : kill ? "Kill switch on" : latched ? "A latch is set" : "Allowed"}
          sub={kill || latched || !chain ? "exits are still managed" : "guards clear"}
          tone={!chain ? "bad" : kill ? "warn" : latched ? "bad" : "good"}
        />
        <Tile
          label="Paper books"
          value={`${num(bk.length)} books`}
          sub={plural(s.desk?.positions ?? items(s.book?.positions).length, "open position")}
          tone="neutral"
        />
        <Tile
          label="Model"
          value={lin ? String(lin.state ?? "unknown") : "none in force"}
          sub={lin ? `${num(lin.finished)} finished signals` : `learning ${s.learning?.switch ?? s.challengers?.learning ?? "unknown"}`}
          tone={lin ? modelTone(lin.state) : "neutral"}
        />
        <Tile
          className="col-span-2 sm:col-span-1"
          label="Challengers live"
          value={typeof ch?.live === "number" ? `${num(ch.live)} of ${num(ch.max_live)}` : "—"}
          sub={typeof ch?.registered === "number" ? `${num(ch.registered)} registered, ${num(ch.retired)} retired` : undefined}
          tone="neutral"
        />
      </ul>
    </WikiSection>
  );
}

const DAILY: { key: string; name: string; when: string }[] = [
  { key: "crypto-challengers", name: "challengers", when: "daily 03:30 ET" },
  { key: "crypto-learn", name: "learning", when: "daily 04:30 ET" },
  { key: "dashboard-crypto", name: "publish", when: "every 15 min, :01" },
];

export function ArchitectureSection({ s }: { s: Crypto }) {
  const id = "dg-carch";
  const last = new Map(entries(s.jobs?.last));
  const cycle = jobDot(last.get("crypto"));
  const all = books(s);
  const shown = all.length > 6 ? all.slice(0, 5) : all;
  const more = all.length - shown.length;
  const slots = shown.length + (more > 0 ? 1 : 0);
  const bw = (480 - (slots - 1) * 8) / slots;
  const label = `Architecture of the crypto desk. Public Kraken and Coinbase data only, behind a wall with no keys and no order route. On the host the bar cycle (last run ${cycle.word}) runs every 15 minutes over ${all.length} paper books (${all
    .map((b) => b.name)
    .join(", ")}), asks a separate ML scorer process, and writes a hash-chained journal through an outbox. Scheduled jobs: ${DAILY.map((d) => `${d.name} (last run ${jobDot(last.get(d.key)).word})`).join(", ")}.`;
  return (
    <WikiSection
      id="architecture"
      eyebrow="Crypto desk"
      title="Architecture"
      lede="A tournament of paper books on public market data, decided by one short job every 15 minutes. There is no daemon: after a reboot or a deploy the next cycle picks up where the journal ended."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">The crypto desk, high level.</b> Kraken has no spot sandbox, so paper means the lab&apos;s own
            simulator on public quotes. The red line is the no-keys wall; a CI test fails if a key or order route is ever added.
          </>
        }
      >
        <Diagram id={id} w={980} h={400} label={label}>
          <T x={20} y={30} caps>
            Public data only
          </T>
          <Node x={20} y={44} w={160} h={52} title="Kraken REST" sub="bars, quotes, clock" tone="info" />
          <Node x={20} y={112} w={160} h={52} title="Coinbase candles" sub="hourly history" />
          <line x1={200} y1={24} x2={200} y2={384} style={{ stroke: "var(--bad-fill)" }} strokeWidth={2} strokeDasharray="8 5" />
          <T x={20} y={214} muted>
            no key, no signing,
          </T>
          <T x={20} y={229} muted>
            no order route
          </T>
          <Zone x={218} y={14} w={512} h={370} label="Trading host" />
          <Node
            x={234}
            y={40}
            w={480}
            h={40}
            title="bar cycle · every 15 min, 10 s after the bar, inside 5 min"
            tone="info"
            dot={{ tone: cycle.tone, pulse: cycle.pulse, title: `bar cycle: last run ${cycle.word}` }}
          />
          <T x={234} y={104} caps>
            Paper books
          </T>
          {shown.map((b, i) => (
            <Node
              key={b.name}
              x={234 + i * (bw + 8)}
              y={112}
              w={bw}
              h={48}
              title={b.challenger ? "challenger" : b.name}
              sub={b.challenger ? b.name.replace(/^ch-/, "") : b.stage ? `C1 ${b.stage}` : "15-min bars"}
              mono={b.challenger}
              tone={b.challenger ? "violet" : undefined}
              dot={{ tone: b.latched ? "bad" : "good", title: `${b.name}${b.stage ? ` (C1 ${b.stage})` : ""}: ${b.latched ? "loss latch set" : "trading on paper"}` }}
            />
          ))}
          {more > 0 ? <Node x={234 + shown.length * (bw + 8)} y={112} w={bw} h={48} title={`+${more} more`} dashed /> : null}
          <Node x={234} y={184} w={150} h={48} title="ML scorer" sub="own process, 20 s" tone="violet" />
          <Node x={400} y={184} w={314} h={48} title="crypto journal" sub="hash-chained, written through an outbox" />
          <T x={234} y={256} caps>
            Scheduled jobs
          </T>
          {DAILY.map((d, i) => {
            const dot = jobDot(last.get(d.key));
            return (
              <Node
                key={d.key}
                x={234 + i * 164}
                y={264}
                w={152}
                h={46}
                title={d.name}
                sub={d.when}
                dot={{ tone: dot.tone, pulse: dot.pulse, title: `${d.name}: last run ${dot.word}` }}
              />
            );
          })}
          <Node x={234} y={326} w={480} h={42} title="var/crypto · book, bars, observations, sleeves, models" mono />
          <Edge diagram={id} d="M180 70 H210 V60 H234" tone="info" flow />
          <Edge diagram={id} d="M180 138 H210 V287 H234" dash />
          <Edge diagram={id} d="M474 80 V112" />
          <Edge diagram={id} d="M360 184 V160" />
          <Edge diagram={id} d="M557 160 V184" />
          <T x={790} y={30} caps>
            Outside the host
          </T>
          <Node x={790} y={34} w={174} h={52} title="ntfy + healthchecks" sub="late, stopped, latch, gap" tone="warn" />
          <Node x={790} y={182} w={174} h={52} title="R2 anchor + backup" sub="daily copy of the head" />
          <Node x={790} y={261} w={174} h={52} title="This site" sub="crypto snapshot slot" tone="info" />
          <Edge diagram={id} d="M714 60 H790" tone="warn" />
          <Edge diagram={id} d="M714 208 H790" />
          <Edge diagram={id} d="M710 287 H790" tone="info" flow />
        </Diagram>
      </Figure>
      <Why title="Why every book is separate.">
        Each sleeve and challenger has its own US$10,000 paper book and its own daily-loss latch, and results are never
        pooled. A fault in one book never touches another, and the baseline runs before any of them.
      </Why>
    </WikiSection>
  );
}

const STEPS: { title: string; sub: string; tone?: Tone }[] = [
  { title: "wake", sub: ":10 s past the bar" },
  { title: "repair", sub: "flush the outbox" },
  { title: "read", sub: "clock, bars, quote" },
  { title: "exits first", sub: "stop, target, time", tone: "good" },
  { title: "entries", sub: "quality, rule, limits" },
  { title: "save, then log", sub: "atomic, never twice", tone: "info" },
];

const RULES: { title: string; sub: [string, string] }[] = [
  { title: "No data, no action", sub: ["an unreadable pair waits", "for the next bar"] },
  { title: "Exits before entries", sub: ["no switch, latch or limit", "ever blocks an exit"] },
  { title: "A bar counts once", sub: ["a re-run for the same bar", "only manages exits"] },
  { title: "Append before save", sub: ["after a crash a line may", "repeat, never go missing"] },
];

export function CycleSection({ s }: { s: Crypto }) {
  const id = "dg-cycle";
  const dot = jobDot(new Map(entries(s.jobs?.last)).get("crypto"));
  return (
    <WikiSection
      id="cycle"
      eyebrow="Crypto desk"
      title="The bar cycle"
      lede="What happens every quarter hour, in order, and the four rules that make it safe to run, re-run and crash."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">One bar cycle.</b> Decisions go into the book&apos;s outbox with a unique id, the book is
            saved atomically, then the outbox is flushed to the journal, skipping ids already written. The sleeves and challengers then run on
            the same bar, and the snapshot publishes a minute later.
          </>
        }
      >
        <Diagram
          id={id}
          w={960}
          h={230}
          label={`One bar cycle, last run ${dot.word}: ${STEPS.map((x) => x.title).join(", ")}. Rules: ${RULES.map((r) => r.title).join("; ")}.`}
        >
          {STEPS.map((x, i) => (
            <g key={x.title}>
              <Node
                x={20 + i * 156}
                y={30}
                w={140}
                h={52}
                title={x.title}
                sub={x.sub}
                tone={x.tone}
                dot={i === 0 ? { tone: dot.tone, pulse: dot.pulse, title: `bar cycle: last run ${dot.word}` } : undefined}
              />
              {i > 0 ? <Edge diagram={id} d={`M${20 + i * 156 - 16} 56 H${20 + i * 156}`} /> : null}
            </g>
          ))}
          <T x={20} y={118} caps>
            Four rules
          </T>
          {RULES.map((r, i) => (
            <Node key={r.title} x={20 + i * 234} y={128} w={218} h={74} title={r.title} sub={r.sub} />
          ))}
        </Diagram>
      </Figure>
    </WikiSection>
  );
}

export function ClockSection({ s, now }: { s: Crypto; now: Date }) {
  const id = "dg-clock";
  const cx = 170;
  const cy = 160;
  const r = 124;
  const last = new Map(entries(s.jobs?.last));
  const utcNow = zoneMinutes(now, "UTC");
  const ahead = utcAheadOfNy(now);
  const at = (min: number) => {
    const a = (min / 1440) * 2 * Math.PI - Math.PI / 2;
    return (rad: number) => ({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
  };
  const current = Math.floor(utcNow / 15);
  const jobs = [
    { key: "crypto-challengers", name: "challengers", ny: 3 * 60 + 30 },
    { key: "crypto-learn", name: "learning", ny: 4 * 60 + 30 },
  ].map((j) => ({ ...j, utc: (j.ny + ahead) % 1440, dot: jobDot(last.get(j.key)) }));
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const a = s.activity;
  const hand = at(utcNow);
  return (
    <WikiSection
      id="clock"
      eyebrow="Crypto desk"
      title="Around the clock"
      lede="The crypto market never closes, so the desk runs 96 cycles every UTC day, every day. The daily jobs keep fixed New York times."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">A UTC day.</b> Each tick is one bar cycle; the hand is now and the highlighted tick is the
            current bar. The two dots are the daily jobs, coloured by their last run.
          </>
        }
      >
        <Diagram
          id={id}
          w={960}
          h={320}
          label={`A UTC day of 96 bar cycles. Now is ${hhmm(utcNow)} UTC. ${typeof a?.cycles_24h === "number" ? `${a.cycles_24h} of ${a.expected_24h ?? 96} cycles ran in the last 24 hours, ${a.failed_24h ?? 0} failed. ` : ""}${jobs
            .map((j) => `${j.name} runs at ${hhmm(j.ny)} New York (${hhmm(j.utc)} UTC), last run ${j.dot.word}`)
            .join("; ")}.`}
        >
          {Array.from({ length: 96 }, (_, i) => {
            const p1 = at(i * 15)(r - 12);
            const p2 = at(i * 15)(r);
            return (
              <line
                key={i}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                strokeWidth={i === current ? 3.5 : 2.2}
                style={{ stroke: i === current ? "var(--info-fill)" : "var(--good-fill)", opacity: i === current ? 1 : 0.55 }}
              />
            );
          })}
          {[0, 6, 12, 18].map((h) => {
            const p = at(h * 60)(r + 18);
            return (
              <T key={h} x={p.x} y={p.y + 4} mono muted anchor="middle">
                {String(h).padStart(2, "0")}
              </T>
            );
          })}
          <line x1={cx} y1={cy} x2={hand(r - 22).x} y2={hand(r - 22).y} style={{ stroke: "var(--info-fill)" }} strokeWidth={2} />
          <circle cx={cx} cy={cy} r={3} style={{ fill: "var(--info-fill)" }} />
          {jobs.map((j) => {
            const p = at(j.utc)(r - 34);
            return <Dot key={j.key} cx={p.x} cy={p.y} r={6} tone={j.dot.tone} pulse={j.dot.pulse} title={`${j.name}: last run ${j.dot.word}`} />;
          })}
          <T x={cx} y={cy + 30} anchor="middle" weight={600}>
            {`${hhmm(utcNow)} UTC`}
          </T>
          <T x={380} y={50} weight={600} size={14}>
            {typeof a?.cycles_24h === "number" ? `${num(a.cycles_24h)} of ${num(a.expected_24h ?? 96)} cycles in the last 24 hours` : "No cycle count in this snapshot"}
          </T>
          <T x={380} y={72} muted>
            {typeof a?.failed_24h === "number" ? `${num(a.failed_24h)} failed. A missed bar is made up by the next one: exits replay 1-minute bars.` : ""}
          </T>
          {jobs.map((j, i) => (
            <g key={j.key}>
              <Dot cx={386} cy={112 + i * 28} r={5} tone={j.dot.tone} pulse={j.dot.pulse} title={`${j.name}: last run ${j.dot.word}`} />
              <T x={400} y={116 + i * 28}>
                {`${j.name} · ${hhmm(j.ny)} New York · ${hhmm(j.utc)} UTC · last run ${j.dot.word}`}
              </T>
            </g>
          ))}
          <T x={380} y={196} muted>
            The snapshot publishes at :01 past each quarter hour, one minute after the cycle, so it never races the book.
          </T>
          <T x={380} y={218} muted>
            This site calls the desk late after 35 minutes and stopped after 90, at any hour;
          </T>
          <T x={380} y={234} muted>
            healthchecks pages if no cycle finished in 45 minutes.
          </T>
        </Diagram>
      </Figure>
    </WikiSection>
  );
}

export function LimitsSection({ s }: { s: Crypto }) {
  const id = "dg-limits";
  const c = s.risk?.limits;
  const d = s.desk;
  const cap = d?.max_open_risk_pct ?? 3;
  const risk = d?.open_risk_pct;
  return (
    <WikiSection
      id="limits"
      eyebrow="Crypto desk"
      title="Risk limits"
      lede="Three nested layers. Every limit only blocks entries; exits are never refused, and a refused signal is still recorded and followed to its outcome."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">Limits nest.</b> A sleeve&apos;s signal can be refused by the desk layer even when its own
            limits allow it. Changing any of these numbers needs a decision record first.
          </>
        }
      >
        <Diagram
          id={id}
          w={960}
          h={250}
          label={`Crypto risk limits. CD across the desk: one position per coin, open risk at most ${cap}% of combined equity, now ${typeof risk === "number" ? `${risk.toFixed(2)}%` : "not reported"}. CT for each sleeve and challenger: 1% risk per trade, 30% per position, 3 positions, 4 entries a day, a 3% daily-loss latch. C for the baseline: three coins, US$${c?.max_notional ?? 50} per entry, US$${c?.max_open_exposure ?? 500} open, latch at US$${c?.daily_loss_latch ?? 20}.`}
        >
          <rect x={20} y={14} width={920} height={222} rx={10} style={{ fill: "color-mix(in srgb, var(--bad-fill) 7%, var(--card))", stroke: "var(--bad-fill)" }} />
          <T x={40} y={40} weight={600}>
            CD · across the desk (sleeves and challengers)
          </T>
          <T x={40} y={60} muted>
            {`one position per coin · open risk at the stops plus the new trade ≤ ${cap}% of the books' combined equity`}
          </T>
          <rect x={40} y={78} width={560} height={140} rx={8} style={{ fill: "color-mix(in srgb, var(--warn-fill) 9%, var(--card))", stroke: "var(--warn-fill)" }} />
          <T x={56} y={102} weight={600}>
            CT · each sleeve and challenger
          </T>
          {["risk 1% per trade · position ≤ 30% · exposure ≤ 100%", "≤ 3 positions · ≤ 4 entries and ≤ 20 orders a UTC day", "daily-loss latch at 3% of the book's equity", "size = the smallest of: by risk, by cap, by cash with fee"].map(
            (t, i) => (
              <T key={i} x={56} y={126 + i * 20} muted>
                {t}
              </T>
            ),
          )}
          <rect x={620} y={78} width={300} height={140} rx={8} style={{ fill: "color-mix(in srgb, var(--info-fill) 9%, var(--card))", stroke: "var(--info-fill)" }} />
          <T x={636} y={102} weight={600}>
            C · the baseline (outside CD)
          </T>
          {[
            "BTC, ETH and SOL only",
            `US$${c?.max_notional ?? 50} per entry, US$${c?.max_open_exposure ?? 500} open`,
            `${c?.max_entries_per_day ?? 3} entries, ${c?.max_orders_per_day ?? 20} orders a UTC day`,
            `latch at US$${c?.daily_loss_latch ?? 20} realised loss,`,
            "kept until the owner clears it",
          ].map((t, i) => (
            <T key={i} x={636} y={126 + i * 20} muted>
              {t}
            </T>
          ))}
        </Diagram>
      </Figure>
      <div className="bg-card grid gap-2 rounded-lg border p-4 sm:max-w-xl">
        <Meter
          label="Desk open risk at the stops"
          value={risk}
          max={cap}
          tone={typeof risk === "number" && risk > cap * 0.8 ? "warn" : "good"}
          valueText={typeof risk === "number" ? `${risk.toFixed(2)}% of ${cap}%` : "not reported"}
        />
        <p className="text-muted-foreground text-xs">
          Refused by the desk layer in the last 7 days: {num(d?.refused_coin_7d ?? 0)} for a coin already held, {num(d?.refused_risk_7d ?? 0)} for
          open risk.
        </p>
      </div>
    </WikiSection>
  );
}

const STATES: { k: string; label: string; x: number; y: number }[] = [
  { k: "shadow", label: "shadow · scores only", x: 40, y: 150 },
  { k: "acting", label: "acting · skip or halve", x: 380, y: 150 },
  { k: "demoted", label: "demoted · never again", x: 720, y: 150 },
  { k: "suspended", label: "suspended · drift", x: 380, y: 240 },
];

export function LearningSection({ s }: { s: Crypto }) {
  const id = "dg-learn";
  const lin = inForce(s);
  const state = String(lin?.state ?? "");
  const finished = lin?.finished ?? 0;
  const next = (Math.floor(finished / 60) + 1) * 60;
  const flow = [
    { t: "rule fires", sub: "on a closed bar" },
    { t: "signal row", sub: "taken or why not, 14 inputs" },
    { t: "follow", sub: "daily, hourly history" },
    { t: "outcome", sub: "exit, reason, R" },
    { t: "labelled data", sub: "trains and tests the model" },
  ];
  return (
    <WikiSection
      id="learning"
      eyebrow="Crypto desk"
      title="The learning loop"
      lede="Every signal, bought or refused, becomes a labelled example. A model may only skip or halve trades of the registered sleeves, and only after it has earned the right."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">From signal to model.</b> Promotion is a statistics test at a checkpoint every 60 finished
            signals. If scoring fails, times out or the model is over 14 days old, every signal trades as its rule says.
          </>
        }
      >
        <Diagram
          id={id}
          w={960}
          h={310}
          label={`The learning loop: ${flow.map((f) => f.t).join(", ")}. Model states shadow, acting, demoted, suspended. ${
            lin ? `The lineage in force is ${state}, with ${finished} finished signals; the next checkpoint is at ${next}.` : "No lineage is in force."
          }`}
        >
          {flow.map((f, i) => (
            <g key={f.t}>
              <Node x={20 + i * 188} y={24} w={170} h={52} title={f.t} sub={f.sub} tone={i === 4 ? "violet" : undefined} />
              {i > 0 ? <Edge diagram={id} d={`M${20 + i * 188 - 18} 50 H${20 + i * 188}`} /> : null}
            </g>
          ))}
          <T x={20} y={124} caps>
            Model states
          </T>
          {STATES.map((st) => {
            const tone = modelTone(st.k);
            const on = st.k === state;
            return (
              <g key={st.k}>
                {on ? (
                  <rect x={st.x - 5} y={st.y - 5} width={210} height={52} rx={26} className="wiki-pulse" style={{ fill: "none", stroke: TONE_VAR[tone] }} strokeWidth={2} />
                ) : null}
                <rect
                  x={st.x}
                  y={st.y}
                  width={200}
                  height={42}
                  rx={21}
                  style={{ fill: `color-mix(in srgb, ${TONE_VAR[tone]} ${on ? 18 : 8}%, var(--card))`, stroke: TONE_VAR[tone] }}
                />
                <T x={st.x + 100} y={st.y + 26} anchor="middle" weight={on ? 600 : undefined}>
                  {st.label}
                </T>
              </g>
            );
          })}
          <Edge diagram={id} d="M240 171 H380" tone="good" />
          <EdgeLabel x={310} y={164}>
            kept beats skipped
          </EdgeLabel>
          <Edge diagram={id} d="M580 171 H720" />
          <EdgeLabel x={650} y={164}>
            fails a later look
          </EdgeLabel>
          <Edge diagram={id} d="M480 192 V240" tone="bad" />
          <EdgeLabel x={488} y={221} anchor="start">
            input drift
          </EdgeLabel>
          <Edge diagram={id} d="M380 261 C 220 261, 140 230, 140 192" dash />
          <EdgeLabel x={228} y={278}>
            retraining ends it
          </EdgeLabel>
          <T x={620} y={250} muted>
            {lin ? `In force: ${lin.lineage ?? "?"}` : "No lineage in force"}
          </T>
          <T x={620} y={268} muted>
            {lin ? `${num(finished)} finished · checkpoints ${num(lin.checkpoints)} · next at ${num(next)}` : `learning ${s.learning?.switch ?? "unknown"}`}
          </T>
        </Diagram>
      </Figure>
    </WikiSection>
  );
}

export function ChallengersSection({ s }: { s: Crypto }) {
  const id = "dg-chal";
  const ch = s.challengers;
  const stages = new Map<string, number>();
  for (const b of items(s.sleeves)) stages.set(b.stage ?? "unknown", (stages.get(b.stage ?? "unknown") ?? 0) + 1);
  const steps: { t: string; sub: string; n: string; tone?: Tone }[] = [
    { t: "Draw", sub: "≤ 2 a week", n: `${num(ch?.drawn_this_week ?? 0)} this week` },
    { t: "Register", sub: "rules logged first", n: `${num(ch?.registered ?? 0)} of ${num(ch?.max_registered ?? 60)}` },
    { t: "Gate C1", sub: "edge after costs", n: `${num(ch?.failed ?? 0)} failed`, tone: "warn" },
    { t: "Confirm", sub: "two earlier years", n: "", tone: "warn" },
    { t: "Live", sub: "own paper book", n: `${num(ch?.live ?? 0)} of ${num(ch?.max_live ?? 6)}`, tone: "good" },
    { t: "Retire", sub: "by rule", n: `${num(ch?.retired ?? 0)} retired` },
  ];
  const gates = [
    { id: "C0", q: "Is the data good enough?" },
    { id: "C1", q: "Is there an edge after costs?" },
    { id: "C2", q: "Does it hold on paper?" },
  ];
  return (
    <WikiSection
      id="challengers"
      eyebrow="Crypto desk"
      title="Challengers and gates"
      lede="New ideas with no person in the loop: each challenger is registered before it is tested and runs the same gauntlet the registered sleeves did."
    >
      <Figure
        caption={
          <>
            <b className="text-foreground font-medium">The challenger funnel.</b> Counts are this snapshot&apos;s. A challenger that fails C1 or the
            confirmation never trades. Below, the three crypto gates and where the desk&apos;s books stand.
          </>
        }
      >
        <Diagram
          id={id}
          w={960}
          h={250}
          label={`Challengers: ${steps.map((x) => `${x.t}${x.n ? ` ${x.n}` : ""}`).join(", ")}. Gates C0, C1, C2. Books by C1 stage: ${[...stages]
            .map(([k, v]) => `${v} ${k}`)
            .join(", ")}.`}
        >
          {steps.map((x, i) => (
            <g key={x.t}>
              <Node x={20 + i * 156} y={24} w={140} h={52} title={x.t} sub={x.sub} tone={x.tone} />
              {i > 0 ? <Edge diagram={id} d={`M${20 + i * 156 - 16} 50 H${20 + i * 156}`} /> : null}
              {x.n ? (
                <T x={20 + i * 156 + 70} y={98} anchor="middle" weight={600}>
                  {x.n}
                </T>
              ) : null}
            </g>
          ))}
          <line x1={80} y1={176} x2={880} y2={176} style={{ stroke: "var(--border)" }} strokeWidth={2} />
          {gates.map((g, i) => {
            const x = 80 + i * 400;
            const extra = g.id === "C1" ? [...stages].map(([k, v]) => `${v} ${k}`).join(", ") : "";
            return (
              <g key={g.id}>
                <circle cx={x} cy={176} r={11} style={{ fill: "var(--card)", stroke: "var(--muted-foreground)" }} strokeWidth={2} />
                <T x={x} y={208} anchor="middle" weight={600}>
                  {g.id}
                </T>
                <T x={x} y={226} anchor="middle" muted>
                  {g.q}
                </T>
                {extra ? (
                  <T x={x} y={244} anchor="middle" size={11}>
                    {`books: ${extra}`}
                  </T>
                ) : null}
              </g>
            );
          })}
          <T x={20} y={140} caps>
            Gates
          </T>
        </Diagram>
      </Figure>
      <Why title="Why register before testing.">
        The exact rules and the trial number go into the journal before the backtest runs, so a bad result can&apos;t be
        quietly dropped. The backtest runs through the same code as the live cycle, so it can&apos;t drift from reality.
      </Why>
    </WikiSection>
  );
}

const CONTROLS: { what: string; cmd: string; refused: string }[] = [
  { what: "Stop new entries", cmd: "make kill DESK=crypto REASON=…", refused: "never" },
  { what: "Allow entries", cmd: "make unkill DESK=crypto", refused: "while a cycle runs, or the evidence chain is broken" },
  { what: "Clear daily-loss latches", cmd: "make reset-crypto-latch", refused: "while a cycle runs" },
  { what: "Model and challengers off or on", cmd: "make crypto-learning-off / -on", refused: "while a cycle runs" },
  { what: "See the challengers", cmd: "make crypto-challengers", refused: "never" },
];

export function ControlsSection() {
  return (
    <WikiSection
      id="controls"
      eyebrow="Crypto desk"
      title="Owner controls"
      lede="Run on the host by the owner. Every control writes a row to the journal; open positions are always managed to their exit."
    >
      <div className="bg-card overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="text-muted-foreground text-left text-[0.6875rem] tracking-wider uppercase">
            <tr>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Command</th>
              <th className="px-4 py-2.5 font-medium">Refused when</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {CONTROLS.map((c) => (
              <tr key={c.cmd}>
                <td className="px-4 py-2.5">{c.what}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.cmd}</td>
                <td className="text-muted-foreground px-4 py-2.5 text-xs">{c.refused}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-xs">Pages and first steps are in docs/runbooks/crypto-desk.md.</p>
    </WikiSection>
  );
}
