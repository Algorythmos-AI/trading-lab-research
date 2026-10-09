import { CorrelationPanel, ExposurePanel, OpportunityPanel, RegimePanel } from "@/components/crypto/market";
import { NoCryptoSnapshot } from "@/components/crypto/panels";
import { PageHeading } from "@/components/page-heading";
import { loadCryptoSnapshot } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crypto market" };

export default async function CryptoMarketPage() {
  const result = await loadCryptoSnapshot();
  return (
    <>
      <PageHeading
        title="Market"
        intro="The market the crypto desk trades in, on its newest closed bars: the state the coins share, each coin strongest first with what the rules made of it, how the coins move together, and what the paper books hold between them. A description, not a signal."
      />
      {result.status !== "ok" ? (
        <NoCryptoSnapshot status={result.status} />
      ) : (
        <>
          <RegimePanel s={result.snapshot} />
          <OpportunityPanel s={result.snapshot} />
          <div className="grid gap-5 xl:grid-cols-2">
            <CorrelationPanel s={result.snapshot} />
            <ExposurePanel s={result.snapshot} />
          </div>
        </>
      )}
    </>
  );
}
