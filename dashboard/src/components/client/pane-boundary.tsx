"use client";

import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { Component, startTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/** The class React needs to catch a render error; everything a reader sees is in PaneBoundary below. */
class Catch extends Component<{ children: ReactNode; fallback: (reset: () => void) => ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

/**
 * Keeps one pane's failure to that pane. If drawing `children` throws, in the browser or on the server, this pane
 * shows a short notice with a retry and every other pane keeps working.
 *
 * There is deliberately no Suspense in here. With one, the server streams large panes as a skeleton first and
 * swaps the content in afterwards, so every page load would flash skeletons and jump. Without one, a healthy page
 * is sent exactly as before. A pane that throws on the server falls back to the route's loading boundary
 * (app/loading.tsx), the browser then draws the page from the data it was sent, and the error surfaces here.
 */
export function PaneBoundary({ name, children }: { name: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <Catch
      fallback={(reset) => (
        <Card role="alert" data-pane-error={name}>
          <CardContent className="flex flex-wrap items-start gap-3 py-1">
            <TriangleAlert aria-hidden className="text-warn mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium">{name} could not be drawn</p>
              <p className="text-muted-foreground text-[0.8125rem]">The rest of the page is unaffected.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                startTransition(() => {
                  router.refresh();
                  reset();
                })
              }
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      )}
    >
      {children}
    </Catch>
  );
}
