import { cn } from "@/lib/utils";

/** A key or a key combination, as printed on the keyboard. Hidden from a screen reader where the control names itself. */
export function Kbd({
  className,
  children,
  ...rest
}: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "bg-muted rounded px-1 font-mono text-[0.625rem]",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
