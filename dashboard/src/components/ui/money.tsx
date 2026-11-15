import { DASH, usd } from "@/lib/format";
import { isEnv, type Env } from "@/lib/env";
import { cn } from "@/lib/utils";

/**
 * A money figure in US dollars, with the evidence class it belongs to. `env` is required: a money figure with no class
 * does not type-check. It formats through lib/format.ts's `usd` ("US$1,234.50", "−US$12.00", "—" when missing);
 * `signed` adds "+" to a gain, and a figure that rounds to US$0.00 carries no sign. It renders `data-money` and
 * `data-env`, and must sit inside an `EnvFrame` of the same class (the guard, test/env-guard.ts, checks a rendered
 * tree). A class a cast let through that is not one of the four fails closed: a dash, marked `data-env="unknown"`.
 */
export function Money({
  env,
  value,
  signed = false,
  className,
}: {
  env: Env;
  value: number | null | undefined;
  signed?: boolean;
  className?: string;
}) {
  if (!isEnv(env)) {
    return (
      <span data-money="" data-env="unknown" className={cn("tabular-nums", className)}>
        {DASH}
      </span>
    );
  }
  const body = usd(value);
  // The sign follows what is shown, not the raw value.
  const zero = body !== DASH && !/[1-9]/.test(body);
  const text = zero ? body.replace("−", "") : signed && body !== DASH && !body.startsWith("−") ? `+${body}` : body;
  return (
    <span data-money="" data-env={env} className={cn("tabular-nums", className)}>
      {text}
    </span>
  );
}
