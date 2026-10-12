import { Skeleton } from "@/components/ui/skeleton";

/**
 * The Options page while it loads: the desk's own outline (its bar, the rows of the monitor, the map), so nothing
 * jumps when the content arrives. A phone shows one pane at a time: the list here, with the bar that switches
 * panes under it. (An address that opens straight on a name still loads through the list's outline.)
 */
export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="bg-card w-[min(calc(100vw-2rem),96rem)] justify-self-center overflow-hidden rounded-xl border xl:h-[calc(100dvh-10.5rem)] xl:min-h-[35rem]"
    >
      <span className="sr-only">Loading</span>
      <div className="flex items-center gap-4 border-b px-3 py-2.5">
        <Skeleton className="h-7 w-44 rounded-md" />
        <Skeleton className="h-3 w-56" />
      </div>
      <div className="xl:grid xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="border-b max-sm:border-b-0 xl:border-r xl:border-b-0">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex h-11 items-center gap-4 border-b px-3 last:border-b-0">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
        <div className="grid content-start gap-4 p-4 max-sm:hidden">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
      </div>
      <div className="flex h-12 items-center justify-around border-t sm:hidden">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  );
}
