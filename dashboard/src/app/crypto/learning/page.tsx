import { LeansOnPanel, ModelPanel, PipelinePanel, SignalsScorecard, TestsPanel, TrainingPanel } from "@/components/crypto/learning";
import { NoCryptoSnapshot } from "@/components/crypto/panels";
import { Empty } from "@/components/empty";
import { PageHeading } from "@/components/page-heading";
import { learning } from "@/lib/learning";
import { loadCryptoSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crypto machine learning" };

export default async function CryptoLearningPage() {
  const result = await loadCryptoSnapshot();
  const l = result.status === "ok" ? learning(result.snapshot) : null;
  return (
    <>
      <PageHeading
        title="Machine learning"
        intro="The model that scores the three strategies' signals: what is in force, the tests it has faced, how the last training compared the models, and whether the learning job is running. It can only skip or halve a paper trade, never add one."
      />
      {result.status !== "ok" || !l ? (
        <NoCryptoSnapshot status={result.status === "ok" ? "missing" : result.status} />
      ) : !l.available ? (
        <Empty title="The model has not published yet">The host publishes this section once its learning job is installed.</Empty>
      ) : (
        <>
          <ModelPanel l={l} />
          <TestsPanel l={l} />
          <TrainingPanel l={l} />
          <div className="grid gap-5 lg:grid-cols-2">
            <LeansOnPanel l={l} />
            <PipelinePanel s={result.snapshot} />
          </div>
          <SignalsScorecard l={l} />
        </>
      )}
    </>
  );
}
