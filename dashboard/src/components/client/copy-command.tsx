"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** A shell command in a mono block with a copy button. Copying is the only thing it does. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="bg-muted flex items-start gap-2 rounded-md border py-1.5 pr-1.5 pl-2.5">
      <code className="min-w-0 flex-1 py-1 font-mono text-xs break-all whitespace-pre-wrap">{command}</code>
      <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={copied ? "Copied" : "Copy command"} title="Copy command">
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}
