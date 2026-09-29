import { logEvent } from "./log";

export interface Notice {
  kind: "late" | "stopped" | "recovered" | "offline";
  title: string;
  message: string;
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
}

/** Pages carry R and % only: any currency amount is replaced before sending. */
export function scrubMoney(text: string): string {
  return text.replace(/(?:[A-Z]{1,3})?\$\s?-?\d[\d,]*(?:\.\d+)?/g, "[amount]").replace(/\$/g, "");
}

/** HTTP header values must be Latin-1; keep titles plain ASCII. */
function asciiHeader(text: string): string {
  return text.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").slice(0, 200);
}

export async function sendNtfy(
  notice: Notice,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<"sent" | "skipped" | "failed"> {
  const topic = env.NTFY_TOPIC;
  if (!topic) {
    logEvent("ntfy", { outcome: "skipped", reason: "NTFY_TOPIC unset", kind: notice.kind });
    return "skipped";
  }
  const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: scrubMoney(notice.message),
      headers: {
        Title: asciiHeader(scrubMoney(notice.title)),
        Priority: String(notice.priority),
        Tags: notice.tags.join(","),
      },
      signal: AbortSignal.timeout(10_000),
    });
    logEvent("ntfy", { outcome: res.ok ? "sent" : "failed", status: res.status, kind: notice.kind });
    return res.ok ? "sent" : "failed";
  } catch (e) {
    logEvent("ntfy", { outcome: "failed", kind: notice.kind, error: e instanceof Error ? e.name : "unknown" });
    return "failed";
  }
}
