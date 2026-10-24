import { Archive } from "lucide-react";
import { Empty } from "@/components/empty";
import { PageHeading } from "@/components/page-heading";
import { deskNote, sinceWords } from "@/lib/desk-state";

export const metadata = { title: "Crypto" };

/**
 * The crypto desk is closed (DEC-0036). One static page in place of the desk's eight: the state, its date, the
 * record that holds it and the counts of the record. SAFE class only: a state word, a date, an id, counts. The
 * record's prose, the rules' names and any money stay in the repository.
 */
export default function CryptoPage() {
  const note = deskNote("crypto");
  const since = sinceWords(note.since);
  return (
    <>
      <PageHeading title="Crypto" intro="The crypto desk is closed. Nothing of it runs, and this site no longer draws its pages." />
      <Empty icon={Archive} title={`Closed${since ? ` on ${since}` : ""}${note.record ? ` (${note.record})` : ""}`}>
        Every registered rule failed gate C1. 12 registered trials and 6 challengers were run; all failed. The decision
        record is in the repository; this page does not repeat it.
      </Empty>
    </>
  );
}
