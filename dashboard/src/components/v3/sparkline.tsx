/** A server-rendered line (no client JS). Values are plotted left to right; a dashed line marks zero. */
export function Sparkline({
  values,
  label,
  className,
  height = 56,
}: {
  values: number[];
  label: string;
  className?: string;
  height?: number;
}) {
  const w = 300;
  if (values.length < 2) return null;
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => height - ((v - lo) / span) * (height - 4) - 2;
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={className ?? "h-14 w-full"}
    >
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />
      <path d={d} fill="none" stroke="var(--chart-1)" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
