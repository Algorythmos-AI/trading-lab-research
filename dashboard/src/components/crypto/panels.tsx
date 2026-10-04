import { Inbox, Power } from "lucide-react";
import { Empty } from "@/components/empty";
import { TONE_TEXT } from "@/components/status";
import { type Crypto } from "@/lib/crypto";
import { sydney } from "@/lib/format";
import type { CryptoResult } from "@/lib/snapshot";
import { cn } from "@/lib/utils";

/** What a crypto page shows before the desk has published, or when storage cannot be read. */
export function NoCryptoSnapshot({ status }: { status: Exclude<CryptoResult["status"], "ok"> }) {
  return status === "missing" ? (
    <Empty icon={Inbox} title="The crypto desk has not published yet">
      The desk is built but not yet running on the host. This page fills in after its first bar cycle and refreshes
      itself every minute.
    </Empty>
  ) : (
    <Empty title="Storage could not be read">The dashboard could not read the crypto desk&apos;s snapshot. It retries every minute.</Empty>
  );
}

export function CryptoKillNotice({ s }: { s: Crypto }) {
  if (s.kill?.on !== true) return null;
  return (
    <section aria-label="Kill switch" className="bg-warn-soft border-warn/35 flex items-start gap-3 rounded-lg border px-4 py-3">
      <Power aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT.warn)} />
      <div className="min-w-0 text-sm">
        <p className="font-medium">Kill switch is on: the crypto desk will not open new positions.</p>
        <p className="text-muted-foreground mt-0.5 text-[0.8125rem]">
          Since {sydney(s.kill.since)} Sydney. It still records every bar and manages exits. Removing the switch is done
          on the host, not here.
        </p>
      </div>
    </section>
  );
}

/** Counts per bin as bars. The numbers are in the table of ranges beside it, so the picture is never alone. */
export function Histogram({
  bins,
  label,
  digits = 1,
}: {
  bins: { lo?: number | null; hi?: number | null; n?: number | null }[];
  label: string;
  digits?: number;
}) {
  const max = Math.max(1, ...bins.map((b) => b.n ?? 0));
  const total = bins.reduce((a, b) => a + (b.n ?? 0), 0);
  if (bins.length === 0 || total === 0) return <Empty title="Not enough observations yet" />;
  const w = 100 / bins.length;
  const first = bins[0]?.lo;
  const last = bins[bins.length - 1]?.hi;
  return (
    <figure className="grid gap-1">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label}: ${total} observations`} className="h-20 w-full">
        {bins.map((b, i) => {
          const h = ((b.n ?? 0) / max) * 38;
          return <rect key={i} x={i * w + 0.4} y={40 - h} width={w - 0.8} height={h} fill="var(--chart-1)" rx={0.4} />;
        })}
      </svg>
      <figcaption className="text-muted-foreground flex justify-between font-mono text-xs">
        <span>{typeof first === "number" ? first.toFixed(digits) : "—"}</span>
        <span>{total} obs</span>
        <span>{typeof last === "number" ? last.toFixed(digits) : "—"}</span>
      </figcaption>
    </figure>
  );
}
