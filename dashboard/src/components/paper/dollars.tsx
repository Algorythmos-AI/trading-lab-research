import { Money } from "@/components/ui/money";

/**
 * A dollar figure of the Paper options page, in the class of the frame it sits in: paper for the clone and the
 * hand-placed account, shadow for the research arms. Never real: the page holds none of the owner's own money. The
 * frames are drawn by paper-page.tsx.
 */
export function Dollars({ env, value, signed = false, className }: { env: "paper" | "shadow"; value: number | null | undefined; signed?: boolean; className?: string }) {
  return env === "shadow" ? <Money env="shadow" value={value} signed={signed} className={className} /> : <Money env="paper" value={value} signed={signed} className={className} />;
}
