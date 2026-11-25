import Link from "next/link";
import type { RegistryIndex } from "@/lib/registry.types";
import { EDGE_LABEL, KIND_LABEL, kindOf, neighbours, recordHref, type EdgeType } from "@/lib/registry-view";
import { KIND_COLOUR } from "./analytics";

/** Which link a line is drawn as: the strongest of the links between the two records. */
const STRENGTH: readonly EdgeType[] = ["supersedes", "superseded_by", "amends", "depends_on", "decision", "hypothesis", "experiment", "base", "evidence", "mentions"];

/**
 * One record and the records it links to or is linked from, one hop, drawn as a ring around it. Solid lines are
 * typed links (depends on, amends, decision, ...); dotted ones are mentions. The arrow points from the record that
 * names the link. Every node is a link to its own page, and the same links are listed in text beside the map.
 */
export function NeighbourGraph({ doc, id, branch }: { doc: RegistryIndex; id: string; branch: "integration" | "main" }) {
  const ns = neighbours(doc, id);
  const known = new Set(doc.records.map((r) => r.id));
  const W = 640;
  const H = ns.length > 12 ? 520 : 420;
  const cx = W / 2;
  const cy = H / 2;
  const rx = W / 2 - 70;
  const ry = H / 2 - 40;
  const kind = kindOf(id) ?? "dec";
  if (ns.length === 0) return <p className="text-muted-foreground text-sm">No other record links to or from {id}.</p>;
  const nodes = ns.map((n, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / ns.length;
    const types = [...n.out, ...n.in];
    const main = STRENGTH.find((t) => types.includes(t)) ?? "mentions";
    return { ...n, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), main, kind: kindOf(n.id) ?? "dec" };
  });
  return (
    <figure className="grid gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-3xl" role="img" aria-label={`${id} and the ${ns.length} records linked to it`}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)" />
          </marker>
        </defs>
        {nodes.map((n) => {
          const outward = n.out.length > 0;
          const inward = n.in.length > 0;
          // Shorten each line so it ends at the node's edge, where its arrow sits.
          const dx = n.x - cx;
          const dy = n.y - cy;
          const len = Math.hypot(dx, dy) || 1;
          const sx = cx + (dx / len) * 62;
          const sy = cy + (dy / len) * 28;
          const ex = n.x - (dx / len) * 52;
          const ey = n.y - (dy / len) * 22;
          return (
            <line
              key={`l-${n.id}`}
              x1={sx}
              y1={sy}
              x2={ex}
              y2={ey}
              stroke="var(--muted-foreground)"
              strokeOpacity={n.main === "mentions" ? 0.45 : 0.85}
              strokeWidth={n.main === "mentions" ? 1 : 1.6}
              strokeDasharray={n.main === "mentions" ? "3 4" : undefined}
              markerEnd={outward ? "url(#arrow)" : undefined}
              markerStart={inward ? "url(#arrow)" : undefined}
            />
          );
        })}
        <g>
          <rect x={cx - 52} y={cy - 18} width={104} height={36} rx={8} fill={KIND_COLOUR[kind]} />
          <text x={cx} y={cy + 5} textAnchor="middle" className="font-mono" fontSize={14} fontWeight={600} fill="white">
            {id}
          </text>
        </g>
        {nodes.map((n) => (
          <Link key={n.id} href={known.has(n.id) ? recordHref(n.id, branch) : `/research/records?q=${n.id}#records`}>
            <g>
              <title>{`${KIND_LABEL[n.kind]} ${n.id}: ${[...n.out.map((t) => EDGE_LABEL[t].out), ...n.in.map((t) => EDGE_LABEL[t].in)].join(", ")}`}</title>
              <rect x={n.x - 44} y={n.y - 14} width={88} height={28} rx={6} fill="var(--card)" stroke={KIND_COLOUR[n.kind]} strokeWidth={2} strokeDasharray={known.has(n.id) ? undefined : "4 3"} />
              <text x={n.x} y={n.y + 4} textAnchor="middle" className="font-mono" fontSize={12} fill="var(--foreground)">
                {n.id}
              </text>
            </g>
          </Link>
        ))}
      </svg>
      <figcaption className="text-muted-foreground text-xs">
        Arrows point from the record that names the link. Solid: a typed link (depends on, amends, decision and so on); dotted: a mention. A dashed box is an id no
        record in this index has.
      </figcaption>
    </figure>
  );
}
