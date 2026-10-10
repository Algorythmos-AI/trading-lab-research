// The Engineering wikis' kit: a contents rail, sections that lead with a picture, a diagram frame, a "why" note,
// and the SVG pieces every diagram is drawn from. Hand-built SVG, like the rest of the site: the page CSP admits no
// diagram library. Green is healthy, amber attention, red failed, blue the data path, violet the crypto desk's
// learning; a colour always comes with a word (a label or a <title>).
import type { Tone } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { TONE_VAR } from "@/lib/wiki";

export interface TocItem {
  id: string;
  label: string;
}

export interface TocGroup {
  title: string;
  items: TocItem[];
}

function TocLinks({ groups }: { groups: TocGroup[] }) {
  return (
    <div className="grid gap-4">
      {groups.map((g) => (
        <div key={g.title} className="grid gap-1">
          <p className="text-muted-foreground text-[0.6875rem] font-medium tracking-wider uppercase">{g.title}</p>
          <ul className="border-border grid border-l">
            {g.items.map((it) => (
              <li key={it.id}>
                <a
                  href={`#${it.id}`}
                  className="text-muted-foreground hover:text-foreground hover:border-primary -ml-px block border-l-2 border-transparent py-1 pl-3 text-[0.8125rem] leading-snug"
                >
                  {it.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** A wiki page: a sticky contents rail beside the sections on wide screens, a "Jump to" menu above them on a phone. */
export function WikiLayout({ toc, children }: { toc: TocGroup[]; children: React.ReactNode }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-10">
      <nav aria-label="On this page" className="hidden lg:block">
        <div className="sticky top-32 max-h-[calc(100vh-9rem)] overflow-y-auto pb-4">
          <TocLinks groups={toc} />
        </div>
      </nav>
      <details className="bg-card rounded-lg border px-4 py-2.5 lg:hidden">
        <summary className="cursor-pointer text-sm font-medium">Jump to a section</summary>
        <div className="pt-3 pb-1">
          <TocLinks groups={toc} />
        </div>
      </details>
      <div className="grid min-w-0 gap-12">{children}</div>
    </div>
  );
}

/** A group heading between sections, e.g. "Lab platform: shared by both desks". */
export function WikiPart({ title, intro, id }: { title: string; intro: React.ReactNode; id?: string }) {
  return (
    <div id={id} className="border-foreground/80 grid scroll-mt-32 gap-1 border-t-2 pt-4">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-muted-foreground max-w-prose text-sm">{intro}</p>
    </div>
  );
}

/** One section: the question it answers, then the picture and its explanation. */
export function WikiSection({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  lede?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid min-w-0 scroll-mt-32 gap-4">
      <header className="grid gap-1">
        {eyebrow ? <p className="text-muted-foreground font-mono text-[0.6875rem] tracking-wider uppercase">{eyebrow}</p> : null}
        <h3 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
          {title}
        </h3>
        {lede ? <p className="text-muted-foreground max-w-prose text-sm">{lede}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** The diagram frame: on a phone a wide diagram pans sideways inside it, never the page. */
export function Figure({ caption, minWidth = 760, children }: { caption: React.ReactNode; minWidth?: number; children: React.ReactNode }) {
  return (
    <figure className="grid min-w-0 gap-2">
      <div className="bg-card overflow-x-auto rounded-lg border">
        <div style={{ minWidth }}>{children}</div>
      </div>
      <figcaption className="text-muted-foreground max-w-prose text-xs">{caption}</figcaption>
    </figure>
  );
}

/** "Why it's built this way": one short note under a picture. */
export function Why({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="border-info-fill bg-info-soft max-w-prose rounded-r-md border-l-2 px-3.5 py-2.5 text-sm">
      <b className="text-info font-semibold">{title}</b> {children}
    </aside>
  );
}

/** A tone dot for HTML lists, with its word beside it. */
export function ToneDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-full", pulse && "wiki-pulse", className)}
      style={{ background: TONE_VAR[tone] }}
    />
  );
}

// ---- SVG pieces ---------------------------------------------------------------------------------------------------

const ARROW_TONES = ["neutral", "good", "info", "warn", "bad"] as const;
type ArrowTone = (typeof ARROW_TONES)[number];
const ARROW_VAR: Record<ArrowTone, string> = { ...TONE_VAR, neutral: "var(--muted-foreground)" };

/** An SVG canvas with one arrowhead marker per tone. `id` must be unique on the page. */
export function Diagram({ id, w, h, label, children }: { id: string; w: number; h: number; label: string; children: React.ReactNode }) {
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="block h-auto w-full">
      <defs>
        {ARROW_TONES.map((t) => (
          <marker key={t} id={`${id}-ah-${t}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" style={{ fill: ARROW_VAR[t] }} />
          </marker>
        ))}
      </defs>
      {children}
    </svg>
  );
}

const TEXT = { fill: "var(--foreground)" } as const;
const SUB = { fill: "var(--muted-foreground)" } as const;

/** Plain diagram text. `muted` for secondary words, `caps` for a small uppercase label. */
export function T({
  x,
  y,
  children,
  muted,
  caps,
  mono,
  size,
  anchor,
  weight,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  muted?: boolean;
  caps?: boolean;
  mono?: boolean;
  size?: number;
  anchor?: "start" | "middle" | "end";
  weight?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size ?? (caps ? 10.5 : muted ? 11 : 12.5)}
      fontWeight={weight}
      letterSpacing={caps ? "0.08em" : undefined}
      fontFamily={mono ? "var(--font-mono)" : undefined}
      textAnchor={anchor}
      style={muted || caps ? SUB : TEXT}
    >
      {caps && typeof children === "string" ? children.toUpperCase() : children}
    </text>
  );
}

/** A labelled box. `tone` tints it; `dot` adds a live status dot (with a <title>) before the title. */
export function Node({
  x,
  y,
  w,
  h,
  title,
  sub,
  tone,
  dot,
  dashed,
  mono,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string | string[];
  tone?: Tone | "violet";
  dot?: { tone: Tone; pulse?: boolean; title: string };
  dashed?: boolean;
  mono?: boolean;
}) {
  const subs = sub === undefined ? [] : Array.isArray(sub) ? sub : [sub];
  const block = 16 + subs.length * 15;
  const ty = y + (h - block) / 2 + 12;
  const tx = x + (dot ? 28 : 12);
  const stroke = tone === "violet" ? "var(--chart-7)" : tone ? TONE_VAR[tone] : "var(--border)";
  const fill =
    tone === "violet"
      ? "color-mix(in srgb, var(--chart-7) 12%, var(--card))"
      : tone
        ? `color-mix(in srgb, ${TONE_VAR[tone]} 11%, var(--card))`
        : "var(--card)";
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={6} style={{ fill, stroke }} strokeWidth={1} strokeDasharray={dashed ? "5 4" : undefined} />
      {dot ? <Dot cx={x + 14} cy={ty - 4} tone={dot.tone} pulse={dot.pulse} title={dot.title} /> : null}
      <T x={tx} y={ty}>
        {title}
      </T>
      {subs.map((s, i) => (
        <T key={i} x={tx} y={ty + 16 + i * 15} muted mono={mono}>
          {s}
        </T>
      ))}
    </g>
  );
}

/** A grouping box with a small caps label. */
export function Zone({ x, y, w, h, label, dashed }: { x: number; y: number; w: number; h: number; label?: string; dashed?: boolean }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        style={{ fill: dashed ? "none" : "var(--muted)", stroke: dashed ? "var(--chart-axis)" : "var(--border)" }}
        strokeDasharray={dashed ? "5 4" : undefined}
      />
      {label ? (
        <T x={x + 14} y={y + 20} caps>
          {label}
        </T>
      ) : null}
    </g>
  );
}

/** A live status dot; pulses while its job runs. */
export function Dot({ cx, cy, tone, pulse, title, r = 4.5 }: { cx: number; cy: number; tone: Tone; pulse?: boolean; title: string; r?: number }) {
  return (
    <circle cx={cx} cy={cy} r={r} className={pulse ? "wiki-pulse" : undefined} style={{ fill: TONE_VAR[tone] }}>
      <title>{title}</title>
    </circle>
  );
}

/** A connector. `flow` animates it as a data path; `dash` marks something occasional. */
export function Edge({
  diagram,
  d,
  tone = "neutral",
  flow,
  dash,
  arrow = true,
}: {
  diagram: string;
  d: string;
  tone?: ArrowTone;
  flow?: boolean;
  dash?: boolean;
  arrow?: boolean;
}) {
  return (
    <path
      d={d}
      className={flow ? "wiki-flow" : undefined}
      style={{ fill: "none", stroke: ARROW_VAR[tone] }}
      strokeWidth={tone === "neutral" ? 1.4 : 1.6}
      strokeDasharray={dash && !flow ? "5 4" : undefined}
      markerEnd={arrow ? `url(#${diagram}-ah-${tone})` : undefined}
    />
  );
}

/** A label on a line: drawn twice, first as a halo in the frame's colour, so it stays readable over the line. */
export function EdgeLabel({ x, y, children, anchor = "middle" }: { x: number; y: number; children: string; anchor?: "start" | "middle" | "end" }) {
  return (
    <g>
      <text x={x} y={y} fontSize={11} textAnchor={anchor} strokeWidth={4} strokeLinejoin="round" style={{ fill: "var(--card)", stroke: "var(--card)" }}>
        {children}
      </text>
      <text x={x} y={y} fontSize={11} textAnchor={anchor} style={SUB}>
        {children}
      </text>
    </g>
  );
}
