import { CloudOff, Inbox } from "lucide-react";
import { Empty } from "./empty";

export function NoSnapshot({ status }: { status: "missing" | "error" }) {
  return status === "missing" ? (
    <Empty icon={Inbox} title="No status snapshot yet">
      The Mac has not published to this deployment yet. The page fills in after the first successful run of the
      publisher and refreshes itself every minute.
    </Empty>
  ) : (
    <Empty icon={CloudOff} title="Storage could not be read">
      The dashboard could not read its private storage. Check that the Blob store is connected to this project. The
      page retries every minute.
    </Empty>
  );
}
