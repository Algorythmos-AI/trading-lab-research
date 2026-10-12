import { cn } from "@/lib/utils";

/**
 * A grey block standing where content will be, sized by `className` (height, width, a rounder corner). It pulses
 * unless the reader has asked for less motion. Shape it like what it stands for, so nothing jumps on arrival.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn("bg-muted rounded motion-safe:animate-pulse", className)}
    />
  );
}
