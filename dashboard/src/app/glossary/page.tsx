import { PageHeading } from "@/components/page-heading";

export const dynamic = "force-dynamic";
export const metadata = { title: "Glossary" };

const TERMS: { term: string; means: string }[] = [
  { term: "R (R-multiple)", means: "A result measured in units of the amount risked. Risking US$6 to the stop and making US$12 is +2R; hitting the stop is −1R." },
  { term: "Expectancy", means: "The average R per trade. Positive means the strategy made more than it risked, on average, over the trades counted." },
  { term: "95% interval", means: "The range the true expectancy plausibly sits in, from resampling the trades (a bootstrap). Shown only from 20 trades: below that it is too wide to mean anything." },
  { term: "Profit factor", means: "Gross R won divided by gross R lost. With no losing trade yet it is undefined, and the page says so instead of showing infinity." },
  { term: "Sharpe ratio", means: "Average daily R divided by its day-to-day spread, scaled to a year. Shown only from 20 trades and 30 armed sessions; days without a trade count as zero." },
  { term: "Drawdown", means: "How far the account is below its best point so far, in % of the virtual account and in R." },
  { term: "Virtual account", means: "A US$600 account kept inside the larger paper account. Strategy B is sized and loss-limited on it, as if it were the real small account." },
  { term: "Latch", means: "A lock the runner puts on itself after a loss limit (−2% in a day, −4% in a week, −10% from the high-water mark). New trades stay off until the owner resets it on the host." },
  { term: "Kill switch", means: "A file on the host that stops new entries. Open trades are still managed and exited. It is never switched from this site." },
  { term: "Refused", means: "A job that stopped itself on purpose because a safety check failed (for example low disk, or code not on main). One alert per day; nothing trades." },
  { term: "Missed", means: "A job that was due on a US trading day and left no record at all. That is the case the dead-man's switches exist to catch." },
  { term: "G2 gate", means: "The paper-trading evidence step. Paper B must reach set counts of trades, sessions and incident-free days before any real-money step is even discussed." },
  { term: "Forward test", means: "Signals recorded live each session with no orders sent, so a strategy's rules can be judged on data it never saw." },
  { term: "Snapshot", means: "The status the trading host publishes every 15 minutes. This site only shows the latest one; it can't change anything." },
  { term: "Audit trail", means: "One time-ordered record of deploys, kill-switch changes, latch resets, refused or failed jobs, and alerts. The owner's own notes never leave the Mac." },
  { term: "Paper", means: "Simulated orders at the broker, with no real money. Everything this lab runs is paper." },
];

export default function GlossaryPage() {
  return (
    <>
      <PageHeading title="Glossary" intro="The terms this site uses, in plain words." />
      <dl className="grid max-w-[80ch] gap-4">
        {TERMS.map((t) => (
          <div key={t.term} className="grid gap-0.5">
            <dt className="text-sm font-medium">{t.term}</dt>
            <dd className="text-muted-foreground text-sm leading-relaxed">{t.means}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
