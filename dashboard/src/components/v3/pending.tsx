import { Hourglass } from "lucide-react";
import { Empty } from "@/components/empty";

/** Shown where a v3 section would be while the host still publishes schema v2 (until its next deploy). */
export function V3Pending({ what }: { what: string }) {
  return (
    <Empty title={`${what} arrives with the next publisher update`} icon={Hourglass}>
      The trading host still publishes schema v2. This fills in after its next deploy; nothing is wrong.
    </Empty>
  );
}
