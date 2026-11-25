// How the arms' simulated trades and the lab's tape status reach this page, drawn live: each box says when it was
// last seen in the paper options document (when the host built it, the lab's latest session, its latest verified
// upload) and is coloured by that state. A stale box is amber, a switched-off one grey; the words carry the state
// too, so colour is never the only signal. Inline SVG in the theme's own colour variables (light and dark); the same
// steps as a list are what a phone shows and what a screen reader reads.
import type { WireState, WireStates } from "@/lib/research-arms";

const W = 128;
const H = 70;
const COL = (i: number) => 8 + i * (W + 12);

type Wire = WireState | "always";
type Box = { x: number; y: number; lines: [string, string]; wire: Wire; seen: string };

const STROKE: Record<Wire, string> = { live: "var(--good-fill)", stale: "var(--warn-fill)", off: "var(--muted-foreground)", unknown: "var(--border)", always: "var(--primary)" };
const FILL: Record<Wire, string> = { live: "var(--card)", stale: "var(--warn-soft)", off: "var(--muted)", unknown: "var(--card)", always: "var(--card)" };
const WORD: Record<WireState, string> = { live: "On time", stale: "Late", off: "Switched off", unknown: "Not seen" };
const TEXT: Record<WireState, string> = { live: "text-good", stale: "text-warn", off: "text-muted-foreground", unknown: "text-muted-foreground" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;

/** "24 Nov 21:14 NY" from an ISO time, in New York; "—" when there is none. */
export function seenAt(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day} ${p.month} ${p.hour}:${p.minute} NY`;
}

function boxes(w: WireStates): { arms: Box[]; lab: Box[] } {
  const doc = seenAt(w.document.seen);
  return {
    arms: [
      { x: COL(0), y: 46, lines: ["runner_o tags +", "wt.options.shadow"], wire: "off", seen: "off from 19 Nov" },
      { x: COL(1), y: 46, lines: ["paper_site.build", "in options-live"], wire: w.document.state, seen: doc },
      { x: COL(2), y: 46, lines: ["Schema check", "before sending"], wire: w.document.state, seen: doc },
      { x: COL(3), y: 46, lines: ["Signed send", "the host's own key"], wire: w.document.state, seen: doc },
      { x: COL(4), y: 46, lines: ["Private Blob", "paper-options/latest"], wire: w.document.state, seen: doc },
      { x: COL(5), y: 46, lines: ["Dashboard reads it", "loadPaperOptions()"], wire: w.document.state, seen: doc },
      { x: COL(6), y: 46, lines: ["This page", "and /paper"], wire: "always", seen: "now" },
    ],
    lab: [
      { x: COL(0), y: 188, lines: ["Lab tape recorder", "session manifests"], wire: w.recorder.state, seen: w.recorder.seen ? `session ${day(w.recorder.seen)}` : "—" },
      { x: COL(1), y: 188, lines: ["lab_tape_status", ".block"], wire: w.document.state, seen: doc },
      { x: COL(0), y: 290, lines: ["Bucket", "wt-lab-tape"], wire: w.upload.state, seen: w.upload.seen ? `${day(w.upload.seen)}${w.upload.minutes !== null ? `, +${Math.round(w.upload.minutes)} min` : ""}` : "—" },
    ],
  };
}

function BoxEl({ b }: { b: Box }) {
  return (
    <g opacity={b.wire === "off" ? 0.75 : 1} data-wire={b.wire}>
      <rect x={b.x} y={b.y} width={W} height={H} rx={8} fill={FILL[b.wire]} stroke={STROKE[b.wire]} strokeWidth={1.75} strokeDasharray={b.wire === "off" || b.wire === "unknown" ? "5 3" : undefined} />
      <text x={b.x + W / 2} y={b.y + 22} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)">
        {b.lines[0]}
      </text>
      <text x={b.x + W / 2} y={b.y + 38} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">
        {b.lines[1]}
      </text>
      <text x={b.x + W / 2} y={b.y + 58} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={b.wire === "stale" ? "var(--warn)" : b.wire === "live" ? "var(--good)" : "var(--muted-foreground)"}>
        {b.seen}
      </text>
    </g>
  );
}

const arrow = { stroke: "var(--muted-foreground)", strokeWidth: 1.25, fill: "none", markerEnd: "url(#ra-arrow)" } as const;

export function Pipeline({ wires }: { wires: WireStates }) {
  const { arms, lab } = boxes(wires);
  const steps: { what: string; state: WireState; seen: string }[] = [
    { what: "The clone (runner_o) wrote the tag arms' flags on its own decisions, and wt.options.shadow booked the shadow arms' simulated trades. Nothing after 17 Nov is shown.", state: "off", seen: "from the 19 Nov session" },
    { what: "paper_site.build, run by the options-live job on the trading host, builds the paper options document, checks it against the dashboard's own schema and sends it signed with the host's own key.", state: wires.document.state, seen: `built ${seenAt(wires.document.seen)}` },
    { what: "The dashboard stores it as the private Blob paper-options/latest.json, and loadPaperOptions() reads it for this page and the Paper page.", state: wires.document.state, seen: "the same document" },
    { what: "Beside it, the lab tape recorder writes a manifest for each session.", state: wires.recorder.state, seen: wires.recorder.seen ? `latest session ${day(wires.recorder.seen)}` : "no session listed" },
    { what: "lab_tape_status.block turns those manifests into the document's lab block.", state: wires.document.state, seen: "with the document" },
    { what: "Each session is uploaded to the bucket wt-lab-tape; its verified receipts give the archived count.", state: wires.upload.state, seen: wires.upload.seen ? `latest verified upload: session ${day(wires.upload.seen)}` : "no verified upload listed" },
  ];
  return (
    <figure className="grid gap-3" data-wires={`${wires.document.state} ${wires.recorder.state} ${wires.upload.state}`}>
      <svg viewBox="0 0 1000 372" className="hidden h-auto w-full sm:block" aria-hidden focusable="false">
        <defs>
          <marker id="ra-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)" />
          </marker>
        </defs>
        <text x={8} y={28} fontSize={12} fontWeight={600} fill="var(--muted-foreground)">
          RESEARCH ARMS
        </text>
        {arms.map((b) => (
          <BoxEl key={b.lines.join()} b={b} />
        ))}
        {arms.slice(0, -1).map((b, i) => (
          <line key={i} x1={b.x + W} y1={b.y + H / 2} x2={arms[i + 1]!.x - 2} y2={b.y + H / 2} {...arrow} />
        ))}
        <text x={8} y={170} fontSize={12} fontWeight={600} fill="var(--muted-foreground)">
          OPTIONS LAB
        </text>
        {lab.map((b) => (
          <BoxEl key={b.lines.join()} b={b} />
        ))}
        <line x1={lab[0]!.x + W} y1={lab[0]!.y + H / 2} x2={lab[1]!.x - 2} y2={lab[1]!.y + H / 2} {...arrow} />
        <line x1={lab[1]!.x + W / 2} y1={lab[1]!.y} x2={arms[1]!.x + W / 2} y2={arms[1]!.y + H + 2} {...arrow} />
        <text x={lab[1]!.x + W / 2 + 8} y={152} fontSize={11} fill="var(--muted-foreground)">
          doc.lab
        </text>
        <line x1={lab[0]!.x + W / 2} y1={lab[0]!.y + H} x2={lab[2]!.x + W / 2} y2={lab[2]!.y - 2} {...arrow} strokeDasharray="4 3" />
        <text x={lab[0]!.x + W / 2 + 8} y={276} fontSize={11} fill="var(--muted-foreground)">
          upload
        </text>
        <path d={`M${lab[2]!.x + W} ${lab[2]!.y + H / 2} H ${lab[1]!.x + W / 2} V ${lab[1]!.y + H + 2}`} {...arrow} strokeDasharray="4 3" />
        <text x={lab[2]!.x + W + 10} y={lab[2]!.y + H / 2 - 6} fontSize={11} fill="var(--muted-foreground)">
          receipts → archived
        </text>
        <text x={COL(3)} y={215} fontSize={11.5} fill="var(--muted-foreground)">
          The tape itself never leaves the host:
        </text>
        <text x={COL(3)} y={232} fontSize={11.5} fill="var(--muted-foreground)">
          only counts, rates and statuses reach this page.
        </text>
      </svg>
      <ol className="text-muted-foreground grid gap-2 text-sm sm:sr-only">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden className="bg-muted text-foreground grid size-6 shrink-0 place-items-center rounded-full font-mono text-xs">
              {i + 1}
            </span>
            <span>
              {s.what}
              <span className={`block text-xs font-medium ${TEXT[s.state]}`}>
                {WORD[s.state]}: {s.seen}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <figcaption>
        <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="What the box colours mean">
          {(
            [
              ["live", "Green edge: seen on time"],
              ["stale", "Amber: late (the document over 26 hours old, or the lab two sessions behind)"],
              ["off", "Grey dashes: switched off"],
              ["unknown", "Plain dashes: not in the document"],
            ] as const
          ).map(([k, label]) => (
            <li key={k} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-3 rounded-sm border-2" style={{ borderColor: STROKE[k], background: FILL[k], borderStyle: k === "off" || k === "unknown" ? "dashed" : "solid" }} />
              {label}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-1.5 text-xs">Read only: nothing on this path can place an order.</p>
      </figcaption>
    </figure>
  );
}
