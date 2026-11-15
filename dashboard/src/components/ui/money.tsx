import { DASH, usd } from "@/lib/format";
import { isEnv, type Env } from "@/lib/env";
import { realUsd } from "@/lib/money-format";
import { cn } from "@/lib/utils";

/**
 * A money figure in US dollars, with the evidence class it belongs to. `env` is required: a money figure with no class
 * does not type-check. The class picks the format, so real money and paper money never look alike:
 *   real                   lib/money-format.ts's `realUsd`: "$1,234", "−$40", whole dollars unless `digits` says
 *                          otherwise (the way the owner's Webull figures have always been written);
 *   paper, shadow, model   lib/format.ts's `usd` (paper-account money): "US$1,234.50", "−US$12.00", always cents;
 *                          `digits` does not apply.
 * Both give "—" when the figure is missing. `signed` adds "+" to a gain, and a figure that rounds to zero carries no
 * sign. It renders `data-money` and `data-env`, and must sit inside an `EnvFrame` of the same class (the guard,
 * test/env-guard.ts, checks a rendered tree). A class a cast let through that is not one of the four fails closed: a
 * dash, marked `data-env="unknown"`.
 */
export function Money({
  env,
  value,
  signed = false,
  digits = 0,
  className,
}: {
  env: Env;
  value: number | null | undefined;
  signed?: boolean;
  /** Decimal places for real money (0 or 2). Paper, shadow and model money always show cents. */
  digits?: number;
  className?: string;
}) {
  if (!isEnv(env)) {
    return (
      <span data-money="" data-env="unknown" className={cn("tabular-nums", className)}>
        {DASH}
      </span>
    );
  }
  let text: string;
  if (env === "real") text = realUsd(value, { digits, signed });
  else {
    const body = usd(value);
    // The sign follows what is shown, not the raw value.
    const zero = body !== DASH && !/[1-9]/.test(body);
    text = zero ? body.replace("−", "") : signed && body !== DASH && !body.startsWith("−") ? `+${body}` : body;
  }
  return (
    <span data-money="" data-env={env} className={cn("tabular-nums", className)}>
      {text}
    </span>
  );
}
