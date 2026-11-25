"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "sending" | "waiting" | "error";

const MESSAGES: Record<string, string> = {
  "already-syncing": "A run is already under way.",
  cooldown: "Started less than a minute ago.",
  "no-token": "The server has no GitHub token, so it cannot start the job.",
  unauthorized: "GitHub refused the server's token.",
  "rate-limited": "GitHub is rate-limiting the server; try again shortly.",
  forbidden: "Refused.",
};

/**
 * Starts the registry job for this branch (POST /api/registry/refresh), then asks for the status every 5 s while a
 * run is under way and redraws the page when it ends. Nothing is shown as refreshed before the server says so.
 */
export function RefreshButton({ branch, syncing }: { branch: "integration" | "main"; syncing: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [phase, setPhase] = useState<Phase>(syncing ? "waiting" : "idle");
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const polls = useRef(0);

  const poll = useCallback(function schedule(): void {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      polls.current++;
      try {
        const r = await fetch(`/api/registry/status?b=${branch}`, { cache: "no-store" });
        const s = (await r.json()) as { state?: string };
        // A dispatched run takes a few seconds to be listed: keep asking for up to a minute before giving up on it.
        if (s.state === "syncing" || (polls.current < 12 && s.state === "out_of_date")) return schedule();
        setPhase("idle");
        setNote(null);
        startTransition(() => router.refresh());
      } catch {
        if (polls.current < 60) return schedule();
        setPhase("error");
        setNote("Could not read the status.");
      }
    }, 5_000);
  }, [branch, router]);

  useEffect(() => {
    if (syncing) {
      polls.current = 0;
      poll();
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [syncing, poll]);

  const start = async () => {
    setPhase("sending");
    setNote(null);
    try {
      const r = await fetch("/api/registry/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string; pretend?: boolean };
      if (r.status === 202 || body.error === "already-syncing") {
        setPhase("waiting");
        setNote(body.pretend ? "Fixture mode: a run is pretended for 20 s." : "The registry job has started.");
        polls.current = 0;
        startTransition(() => router.refresh());
        poll();
        return;
      }
      setPhase("error");
      setNote(MESSAGES[body.error ?? ""] ?? "The job could not be started.");
    } catch {
      setPhase("error");
      setNote("The dashboard could not be reached.");
    }
  };

  const busy = phase === "sending" || phase === "waiting";
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button variant="outline" size="sm" onClick={start} disabled={busy} aria-describedby={note ? `refresh-note-${branch}` : undefined}>
        <RefreshCw aria-hidden className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
        {phase === "sending" ? "Starting…" : phase === "waiting" ? "Syncing…" : "Refresh"}
      </Button>
      <p id={`refresh-note-${branch}`} role="status" className="text-muted-foreground min-h-4 text-xs">
        {note}
      </p>
    </div>
  );
}
