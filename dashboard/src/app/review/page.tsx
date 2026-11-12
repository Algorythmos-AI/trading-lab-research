import { DayReviewBody } from "@/components/day-review";
import { loadJournal, pageTime } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Day review" };

/** One New York day of the owner's option positions against his rules (`?day=YYYY-MM-DD`; the latest day otherwise). */
export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [q, result, now] = await Promise.all([searchParams, loadJournal(), pageTime()]);
  return <DayReviewBody result={result} q={q} now={now} />;
}
