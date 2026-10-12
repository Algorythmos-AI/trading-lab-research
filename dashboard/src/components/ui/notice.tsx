import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A line that says something is wrong or may be: a warning triangle and a sentence. `tone` is how bad ("warn":
 * needs a look; "bad": do not rely on what is here). `size` follows the text around it. Pass `role="status"` for
 * a state that can change while the page is open, `role="alert"` for one the reader must not miss.
 */
export function Notice({
  tone = "warn",
  size = "xs",
  role,
  className,
  children,
}: {
  tone?: "warn" | "bad";
  size?: "xs" | "sm";
  role?: "status" | "alert";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      role={role}
      className={cn(
        tone === "bad" ? "text-bad" : "text-warn",
        "flex items-start",
        size === "sm" ? "gap-2 text-sm" : "gap-1.5 text-xs",
        className,
      )}
    >
      <TriangleAlert
        aria-hidden
        className={cn("mt-0.5 shrink-0", size === "sm" ? "size-4" : "size-3.5")}
      />
      {children}
    </p>
  );
}
