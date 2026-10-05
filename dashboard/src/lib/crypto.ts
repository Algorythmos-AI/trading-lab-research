// The crypto desk's view helpers (ADR 0005). Pure: no I/O, no clock.
import type { CryptoSnapshot } from "./crypto.types";
import { DASH } from "./format";
import type { Freshness } from "./freshness";
import type { Health, HealthReason } from "./health";

export type Crypto = CryptoSnapshot;

export function items<T>(v: readonly (T | null | undefined)[] | null | undefined): T[] {
  return (v ?? []).filter((x): x is T => x !== null && x !== undefined);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const SYMBOL: Record<string, string> = { USD: "US$", AUD: "A$" };
export const CURRENCY_NAME: Record<string, string> = { USD: "US dollars", AUD: "Australian dollars" };

/** Paper book money in a quote currency ("USD" -> "US$1,234.50"). Only ever shown behind the owner's login. */
export function money(v: number | null | undefined, currency: string | null | undefined, digits = 2): string {
  if (!isNum(v)) return DASH;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sym = SYMBOL[currency ?? ""] ?? (currency ? `${currency} ` : "");
  return `${v < 0 ? "−" : ""}${sym}${s}`;
}

/** A formatter bound to the desk's own quote currency, as its snapshot states it. */
export function moneyOf(s: Crypto): (v: number | null | undefined, digits?: number) => string {
  const currency = s.config?.quote_currency;
  return (v, digits = 2) => money(v, currency, digits);
}

/** A spread in percent. Liquid pairs sit near 0.0001%, which two decimals would print as "0.00%". */
export function spreadPct(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${v.toFixed(v !== 0 && Math.abs(v) < 0.01 ? 4 : 2)}%`;
}

/** "1 day", "2 days". */
export function plural(n: number | null | undefined, one: string, many = `${one}s`): string {
  return isNum(n) ? `${n.toLocaleString("en-US")} ${n === 1 ? one : many}` : DASH;
}

/** Plain words for the codes the desk publishes. An unknown code is shown as it is. */
const CODES: Record<string, string> = {
  rsi_high: "RSI not low enough",
  below_vwap: "below session VWAP",
  below_ema: "below EMA-8",
  no_rsi: "no RSI yet",
  no_ema: "no EMA yet",
  no_vwap: "no trades today yet",
  bar_untraded: "nobody traded in the bar",
  bar_stale: "newest bar is old",
  spread_wide: "spread too wide",
  quote_stale: "quote too old",
  no_quote: "no quote",
  no_bars: "no bars",
  kill: "kill switch on",
  latch: "loss latch set",
  chain_broken: "evidence chain broken",
  shadow_role: "shadow host",
  not_allowlisted: "pair not allowed",
  already_open: "position already open",
  notional: "over the per-entry limit",
  exposure: "over the exposure limit",
  entries_today: "entry limit for the day reached",
  orders_today: "order limit for the day reached",
  below_minimum: "below the venue minimum",
  insufficient_cash: "not enough cash",
  no_pair_info: "pair details unavailable",
  stop: "Stop",
  target: "Target",
  time: "Time stop",
};

export function code(c: string | null | undefined): string {
  return typeof c === "string" && c ? (CODES[c] ?? c) : DASH;
}

export function codes(list: readonly (string | null)[] | null | undefined): string {
  const out = items(list).map(code);
  return out.length > 0 ? out.join(", ") : DASH;
}

/** Green / amber / red for the crypto desk, with a reason for every step away from green. */
export function cryptoHealth(s: Crypto, freshness: Freshness): Health {
  const fresh = freshness.state;
  const reasons: HealthReason[] = [];
  if (fresh === "stopped") reasons.push({ code: "stopped", level: "red", text: "The crypto desk has stopped publishing." });
  if (s.risk?.chain_ok === false) {
    reasons.push({ code: "chain", level: "red", text: "The crypto journal's hash chain is broken; entries are off." });
  }
  for (const a of items(s.alerts?.firing)) {
    if (a.key === "crypto:data-stale") {
      reasons.push({ code: "data", level: "red", text: "No market data from the venue; open positions are not being watched." });
    } else if (typeof a.key === "string" && a.key.startsWith("crypto:exit-gap")) {
      reasons.push({ code: a.key, level: "red", text: "An open position has a stretch of prices nobody observed." });
    }
  }
  if (fresh === "late") reasons.push({ code: "late", level: "amber", text: "The crypto desk's update is late." });
  if (s.risk?.latched === true) {
    reasons.push({ code: "latch", level: "amber", text: "The daily loss limit was reached; entries stay off until the owner resets the latch." });
  }
  if (s.kill?.on === true) {
    reasons.push({ code: "kill", level: "amber", text: "Kill switch is on: the crypto desk makes no new entries." });
  }
  const a = s.activity;
  if (isNum(a?.cycles_24h) && isNum(a?.expected_24h) && a.expected_24h > 0 && a.cycles_24h < a.expected_24h * 0.9) {
    reasons.push({ code: "cycles", level: "amber", text: `Only ${a.cycles_24h} of ${a.expected_24h} bar cycles ran clean in the last 24 hours.` });
  }
  const level = reasons.some((r) => r.level === "red") ? "red" : reasons.length > 0 ? "amber" : "green";
  return { level, reasons, freshness };
}
