import { Lock, OctagonX, ShieldCheck } from "lucide-react";
import { Panel } from "@/components/panel";
import { StatusBadge, TONE_ICON, TONE_TEXT } from "@/components/status";
import { describeAge } from "@/lib/freshness";
import { sydney } from "@/lib/format";
import type { OptionsClone } from "@/lib/options-clone.types";
import type { GapHunterLiveResult } from "@/lib/snapshot";
import { safetyView, type SafetyTile, type SourceStamp } from "@/lib/safety-tiles";
import type { Snapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

const TILE_BG = { good: "bg-good-soft", warn: "bg-warn-soft", bad: "bg-bad-soft", info: "bg-card", neutral: "bg-card" } as const;
const TILE_EDGE = { good: "border-good-fill/40", warn: "border-warn-fill/50", bad: "border-bad-fill/60", info: "border-border", neutral: "border-border" } as const;

function Tile({ t, stale }: { t: SafetyTile; stale: boolean }) {
  const Icon = TONE_ICON[t.tone];
  return (
    <li
      className={cn("flex min-h-24 min-w-0 flex-col gap-1 rounded-lg border p-3", TILE_BG[t.tone], TILE_EDGE[t.tone])}
      data-switch={t.key}
      data-on={t.on === null ? "unknown" : String(t.on)}
    >
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {t.kind === "kill" ? <OctagonX aria-hidden className="size-3.5 shrink-0" /> : <Lock aria-hidden className="size-3.5 shrink-0" />}
        <span className="min-w-0">{t.label}</span>
      </p>
      <p className={cn("flex items-center gap-1.5 text-lg leading-tight font-semibold", TONE_TEXT[t.tone])}>
        <Icon aria-hidden className="size-5 shrink-0" />
        {t.word}
      </p>
      {t.detail ? <p className="text-muted-foreground text-xs leading-snug">{t.detail}</p> : null}
      {stale && t.on !== true ? <p className="text-warn text-xs leading-snug">Source is late: this may have changed.</p> : null}
    </li>
  );
}

function Stamp({ s }: { s: SourceStamp }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1" data-source={s.source} data-stale={String(s.stale)}>
      <span className="font-medium">{s.label}</span>
      <span>{s.asOf ? `as of ${sydney(s.asOf)} Sydney${s.ageMin !== null ? `, ${describeAge(s.ageMin)}` : ""}` : "not sent"}</span>
      {s.stale ? <StatusBadge tone="warn">Stale</StatusBadge> : null}
    </li>
  );
}

/** Every kill file and loss latch this site is sent, one tile each: green when it lets entries through. */
export function SafetyTiles({ s, clone, gapLive, nowMs }: { s: Snapshot | null; clone: OptionsClone | null; gapLive: GapHunterLiveResult | null; nowMs: number }) {
  const v = safetyView(s, clone, nowMs, gapLive);
  const badge =
    v.overall === "on" ? (
      <StatusBadge tone="bad">{v.onCount === 1 ? "1 switch on" : `${v.onCount} switches on`}</StatusBadge>
    ) : v.overall === "unknown" ? (
      <StatusBadge tone="neutral">{v.unknownCount === v.tiles.length ? "Not sent" : `${v.unknownCount} not sent`}</StatusBadge>
    ) : v.overall === "stale" ? (
      <StatusBadge tone="warn">Stale</StatusBadge>
    ) : (
      <StatusBadge tone="good" icon={ShieldCheck}>
        All clear
      </StatusBadge>
    );
  return (
    <Panel
      id="safety"
      title="Safety switches"
      icon={ShieldCheck}
      means="Each kill file and loss latch this site is sent. Green lets new entries through; red stops them (exits are always managed). They are switched on the host, never from this page."
      action={badge}
    >
      <div className="grid gap-3">
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Safety switches">
          {v.tiles.map((t) => (
            <Tile key={t.key} t={t} stale={v.sources.find((x) => x.source === t.source)?.stale ?? false} />
          ))}
        </ul>
        <ul className="text-muted-foreground grid gap-1 text-xs" aria-label="Where these states came from">
          {v.sources.map((x) => (
            <Stamp key={x.source} s={x} />
          ))}
        </ul>
      </div>
    </Panel>
  );
}
