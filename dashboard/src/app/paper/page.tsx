import { PageHeading } from "@/components/page-heading";
import { PaperBody } from "@/components/paper/paper-page";
import { loadOptionsClone, loadOptionsLive, loadPaperOptions, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Paper options" };

export default async function PaperPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [q, result, clone, live, now] = await Promise.all([searchParams, loadPaperOptions(), loadOptionsClone(), loadOptionsLive(), pageTime()]);
  return (
    <>
      <PageHeading
        title="Paper options"
        phoneIntro="Every paper option trade: the clone bot's, your own in the paper account, and the simulated research arms. Paper money only; nothing here can trade."
        intro="Every paper option trade in one place: the clone bot's, the ones you place by hand in the paper account, and the simulated research arms. What each made or lost, where, and whether it is getting better. Paper money only; nothing here is your real account and nothing here can trade."
      />
      <PaperBody result={result} clone={clone} live={live} q={q} now={now} />
    </>
  );
}
