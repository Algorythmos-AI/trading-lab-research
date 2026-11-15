import { envMeta, isEnv, type Env } from "@/lib/env";
import { cn } from "@/lib/utils";

/** The value written to `data-env`: the class, or "unknown" when a cast let something else through. */
const envAttr = (env: unknown) => (isEnv(env) ? env : "unknown");

/**
 * The evidence class of what sits beside it: "REAL · WEBULL", "PAPER · ALPACA", "SHADOW · SIM" or "MODEL · BACKTEST".
 * Each class has its own border style as well as its own colour (lib/env.ts), so the chip reads without colour.
 * `className` may place the chip (margins); the class's own border and colours are applied last and cannot be undone.
 */
export function EnvChip({ env, className }: { env: Env; className?: string }) {
  const meta = envMeta(env);
  return (
    <span
      data-slot="env-chip"
      data-env={envAttr(env)}
      title={meta.description}
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-semibold tracking-wide whitespace-nowrap",
        className,
        meta.chipClass,
      )}
    >
      {meta.chip}
    </span>
  );
}

/**
 * A region whose figures all come from one evidence class. It sets `data-env` (the guard test reads it) and, for
 * every class but real, draws a frame in the class's border style with the class's chip at its top. A real region is
 * not framed. `chip={false}` leaves the chip out where a heading beside the frame already carries one.
 *
 * The frame cannot be talked out of its class: `data-env`, `role`, `style` and the accessible name are its own, and
 * its border and padding are applied after `className` (which may still lay the region out: margins, grid, gaps).
 * `label` names the region after the class: "Paper account (Alpaca): Positions". Other attributes go on the wrapper.
 */
export function EnvFrame({
  env,
  chip = true,
  label,
  className,
  children,
  ...rest
}: {
  env: Env;
  chip?: boolean;
  label?: string;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentProps<"div">, "children" | "className" | "role" | "style" | "aria-label" | "aria-labelledby">) {
  const meta = envMeta(env);
  const framed = env !== "real" || !isEnv(env);
  // Strip anything a cast slipped past the prop types.
  const { role: _role, style: _style, "aria-label": _al, "aria-labelledby": _alb, ...attrs } = rest as typeof rest & {
    role?: unknown;
    style?: unknown;
    "aria-label"?: unknown;
    "aria-labelledby"?: unknown;
  };
  void [_role, _style, _al, _alb];
  return (
    <div
      {...attrs}
      role="group"
      aria-label={label ? `${meta.name}: ${label}` : meta.name}
      data-env-frame=""
      data-env={envAttr(env)}
      className={cn(className, framed && meta.frameClass, framed && "p-2")}
    >
      {chip ? <EnvChip env={env} className="mb-1.5" /> : null}
      {children}
    </div>
  );
}
