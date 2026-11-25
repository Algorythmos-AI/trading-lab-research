import { PageHeading } from "@/components/page-heading";
import { ArmsStory } from "@/components/research-arms/arms-story";
import { loadPaperOptions, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Research arms" };

export default async function ResearchArmsPage() {
  const [result, now] = await Promise.all([loadPaperOptions(), pageTime()]);
  return (
    <>
      <PageHeading
        title="Research arms"
        phoneIntro="The options clone's fourteen research arms: where they came from, why they ended with no verdict, and what replaced them."
        intro="The whole story of the options clone's fourteen research arms: where they came from, the two kinds, the booking window, why they ended with no verdict, and what replaced them. Paper and simulated only; nothing here can trade."
      />
      <ArmsStory result={result} now={now} />
    </>
  );
}
