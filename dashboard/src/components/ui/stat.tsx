/** A label over its value: the desk's way of stating a fact, one unit per cell. For use inside a `<dl>`. */
export function Stat({
  label,
  children,
  title,
}: {
  label: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-muted-foreground truncate text-[0.6875rem]">
        {label}
      </dt>
      <dd className="truncate font-mono text-[0.8125rem]">{children}</dd>
    </div>
  );
}
