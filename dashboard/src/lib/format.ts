// Deterministic formatting for server components. Every helper returns "—" for null/undefined/NaN.
export const DASH = "—";
export const SYDNEY = "Australia/Sydney";
export const NEW_YORK = "America/New_York";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function txt(v: string | number | null | undefined): string {
  if (isNum(v)) return String(v);
  return typeof v === "string" && v.trim() ? v : DASH;
}

export function num(v: number | null | undefined, digits = 0): string {
  if (!isNum(v)) return DASH;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signed(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return DASH;
  const body = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (Number(body.replace(/,/g, "")) === 0) return body;
  return `${v > 0 ? "+" : "−"}${body}`;
}

/** R-multiples: "+0.117R". */
export function rMult(v: number | null | undefined, digits = 3): string {
  const s = signed(v, digits);
  return s === DASH ? s : `${s}R`;
}

/** A value already in percent: 84 -> "84.0%". */
export function pct(v: number | null | undefined, digits = 1): string {
  return isNum(v) ? `${num(v, digits)}%` : DASH;
}

/** A 0..1 fraction: 0.569 -> "56.9%". */
export function fracPct(v: number | null | undefined, digits = 1): string {
  return isNum(v) ? `${num(v * 100, digits)}%` : DASH;
}

/** Paper account money only. Never used in the summary sentence or pages sent to the phone. */
export function usd(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : ""}US$${s}`;
}

export function shortSha(v: string | null | undefined): string {
  return typeof v === "string" && v ? v.slice(0, 7) : DASH;
}

function parse(iso: string | null | undefined): Date | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, withDate: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${withDate}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(withDate ? { weekday: "short", day: "numeric", month: "short" } : {}),
    });
    formatters.set(key, f);
  }
  return f;
}

/** "Tue 29 Sep, 21:30" in the given zone. */
export function zoned(iso: string | null | undefined, tz: string, withDate = true): string {
  const d = parse(iso);
  return d ? fmt(tz, withDate).format(d) : DASH;
}

export const sydney = (iso: string | null | undefined, withDate = true) => zoned(iso, SYDNEY, withDate);
export const newYork = (iso: string | null | undefined, withDate = true) => zoned(iso, NEW_YORK, withDate);

/** "YYYY-MM-DD" of an instant in a zone (en-CA formats dates that way). */
export function dayIn(iso: string | null | undefined, tz: string): string | null {
  const d = parse(iso);
  if (!d) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Duration between two instants: "4 h 01 min", "51 s". */
export function duration(startIso: string | null | undefined, endIso: string | null | undefined): string {
  const a = parse(startIso);
  const b = parse(endIso);
  if (!a || !b || b < a) return DASH;
  const s = Math.round((b.getTime() - a.getTime()) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** "Sep 29" style short date from "YYYY-MM-DD" without timezone drift. */
export function shortDate(ymd: string | null | undefined): string {
  if (typeof ymd !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return txt(ymd);
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(date);
}
