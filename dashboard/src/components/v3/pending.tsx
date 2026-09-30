import { Hourglass, TriangleAlert } from "lucide-react";
import { Empty } from "@/components/empty";

/** Where a v3 host sent no value for a section: it failed to build it. Never shown as an empty, quiet state. */
export function V3Missing({ what }: { what: string }) {
  return (
    <Empty title={`${what} is not in this snapshot`} icon={TriangleAlert}>
      The trading host could not build this section in its last publish. The rest of the page is current; the
      publisher logs the reason.
    </Empty>
  );
}

/** Shown where a v3 section would be while the host still publishes schema v2 (until its next deploy). */
export function V3Pending({ what }: { what: string }) {
  return (
    <Empty title={`${what} arrives with the next publisher update`} icon={Hourglass}>
      The trading host still publishes schema v2. This fills in after its next deploy; nothing is wrong.
    </Empty>
  );
}
