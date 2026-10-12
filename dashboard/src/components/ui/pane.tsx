/**
 * One pane of the desk's drawer: a labelled section with its title on the left and what it is as of on the right.
 * Extra attributes (the `data-` hooks the tests and the styles read) go on the section.
 */
export function Pane({
  label,
  title,
  meta,
  children,
  ...rest
}: {
  label: string;
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"section">, "title" | "children" | "className">) {
  return (
    <section aria-label={label} className="border-t px-3 py-2.5" {...rest}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[0.8125rem] font-medium">{title}</h3>
        {meta != null ? (
          <span className="text-muted-foreground text-[0.6875rem]">{meta}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}
