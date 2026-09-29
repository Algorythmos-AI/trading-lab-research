export function PageHeading({ title, intro }: { title: string; intro: string }) {
  return (
    <div className="grid gap-1">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{intro}</p>
    </div>
  );
}
