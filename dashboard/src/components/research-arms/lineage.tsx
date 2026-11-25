// The records behind the arms, by id: which registered, ran, ended, stopped and replaced them. Its data is one small
// typed module (lib/research-lineage.ts) that the Reference Registry can replace. Each id opens the record's page.
import { FAMILY_O, LINEAGE_EDGES, LINEAGE_NODES, nodeLabel, type LineageKind } from "@/lib/research-lineage";
import { recordHref } from "@/lib/research-arms";

const NW = 132;
const NH = 40;
const pos = (col: number, row: number) => ({ x: 6 + col * 166, y: 14 + row * 74 });
const COLOR: Record<LineageKind, string> = { DEC: "var(--chart-1)", HYP: "var(--chart-4)", EXP: "var(--chart-3)" };
const byId = new Map(LINEAGE_NODES.map((n) => [n.id, n]));

export function Lineage() {
  return (
    <figure className="grid gap-3">
      <svg viewBox="0 0 1000 196" className="hidden h-auto w-full sm:block" role="group" aria-label="Record lineage of the research arms">
        <defs>
          <marker id="ra-lin-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)" />
          </marker>
        </defs>
        {LINEAGE_EDGES.map((e) => {
          const a = byId.get(e.from)!;
          const b = byId.get(e.to)!;
          const p = pos(a.col, a.row);
          const q = pos(b.col, b.row);
          const x1 = p.x + NW;
          const y1 = p.y + NH / 2;
          const x2 = q.x - 2;
          const y2 = q.y + NH / 2;
          return (
            <g key={`${e.from}-${e.to}`}>
              <path d={`M${x1} ${y1} C ${x1 + 20} ${y1}, ${x2 - 20} ${y2}, ${x2} ${y2}`} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.25} markerEnd="url(#ra-lin-arrow)" />
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
                {e.says}
              </text>
            </g>
          );
        })}
        {LINEAGE_NODES.map((n) => {
          const p = pos(n.col, n.row);
          return (
            <a key={n.id} href={recordHref(n.id)} aria-label={`${nodeLabel(n)}: open the record`}>
              <rect x={p.x} y={p.y} width={NW} height={NH} rx={8} fill="var(--card)" stroke={COLOR[n.kind]} strokeWidth={2} />
              <text x={p.x + NW / 2} y={p.y + 25} textAnchor="middle" fontSize={12.5} fontWeight={600} fontFamily="var(--font-mono, monospace)" fill="var(--foreground)">
                {nodeLabel(n)}
              </text>
            </a>
          );
        })}
      </svg>
      <ol className="grid gap-1.5 text-sm sm:sr-only" aria-label="Record lineage, in order">
        {LINEAGE_EDGES.map((e) => (
          <li key={`${e.from}-${e.to}`}>
            <a href={recordHref(e.from)} className="font-mono underline decoration-dotted underline-offset-2">
              {nodeLabel(byId.get(e.from)!)}
            </a>{" "}
            <span className="text-muted-foreground">{e.says}</span>{" "}
            <a href={recordHref(e.to)} className="font-mono underline decoration-dotted underline-offset-2">
              {nodeLabel(byId.get(e.to)!)}
            </a>
          </li>
        ))}
      </ol>
      <figcaption className="text-muted-foreground text-xs">
        Blue: decisions. Amber: the hypotheses. Green: experiments. Family O went from {FAMILY_O.before} to {FAMILY_O.after} trials with {FAMILY_O.by}.
      </figcaption>
    </figure>
  );
}
