export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="grid gap-4">
      <span className="sr-only">Loading</span>
      <div className="bg-muted h-24 animate-pulse rounded-lg" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="bg-muted h-48 animate-pulse rounded-lg" />
        <div className="bg-muted h-48 animate-pulse rounded-lg" />
      </div>
    </div>
  );
}
