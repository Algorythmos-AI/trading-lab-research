# DEC-0029: Options desk, pricing the probation rules' cases as the options they stand for

- **Status: PROPOSED on 2026-10-12.** Drafted for the owner to change or accept. It becomes ACCEPTED only when
  the owner merges a pull request that says so in this line. **Nothing below is built or run before that**, and
  no option-priced result has been looked at in drafting it.
- **Depends on:** DEC-0028 (the four rules, family O, the promotion test).
- **Does not amend** DEC-0028. It supplies the missing input its promotion test names: "after option costs".
- **Date drafted:** 2026-10-12.

## Why

DEC-0028's promotion test asks whether a rule's cases are worth anything after the cost of the option that
expresses them. The paper record cannot say: it is in R on the stock. Until something can, no rule can be
promoted or dropped on the question that matters to a buyer of calls and puts.

This record fixes, before any result exists, how a case is turned into an option trade and how that trade is
priced. Every choice below changes the answer, which is why each is written down first.

## What was checked before drafting (availability only, no results)

- The market-data feed returns historical **trade bars** for option contracts, expired ones included, back
  to at least March 2026: hourly and five-minute, with volume and a volume-weighted price.
- It returns **no historical quotes** on the lab's plan. Bid and ask at the moment of a case cannot be read
  back, so the spread has to be assumed. That is the weakest part of this design, and it is stated as such.

## Decision

### 1. What is priced
Each case the registered rules produce (`wt.options.rules.probation_triggers`): a name, a session, a rule, the
hourly close it triggered on, and how it ended on the stock (stop, target, or the session's close).

### 2. Which contract (two registered variants)
The side is the rule's: a call for the two long rules, a put for the two short ones. One contract. The strike
is the listed strike nearest the stock's price at the trigger (of two equally near, the lower).

| Variant | Expiry | Why |
|---|---|---|
| **N, near** | the first listed expiry at least 1 calendar day after the session | what a same-day trader reaches for; the most sensitive to time decay |
| **W, a week out** | the first listed expiry at least 7 calendar days after the session | less decay over a few hours, more premium at risk |

Same-day expiries are left out on purpose: in a contract's last hours a five-minute bar is not a price a
buyer could rely on.

Two variants on four rules are **8 new trials**: family O goes from 12 to **20**. The registry row is added
as `proposed` and flips with this record.

### 3. The prices
- **Entry:** the volume-weighted price of the contract's first five-minute bar that starts at or after the
  trigger's hourly close, **plus half the assumed spread**.
- **Exit:** the volume-weighted price of the contract's last five-minute bar that starts before the stock
  case's exit time (the end of the hourly bar in which the stop or target was reached, or the session's
  close), **less half the assumed spread**.
- **The assumed spread**, as a full bid-to-ask width:

  | Names | Width |
  |---|---|
  | SPY, QQQ | the larger of $0.02 and 2% of the contract's price |
  | the other eight | the larger of $0.05 and 4% of the contract's price |

  Every result is also reported at **twice** these widths. A verdict has to hold at both.
- **Fees:** $0.03 a contract each way.
- **No bar, no trade:** a case whose contract has no five-minute bar within 15 minutes after the trigger is
  left out and counted. So is one with no bar before the exit time. If more than a fifth of a rule's cases
  are left out, that rule has no verdict from this experiment.

### 4. The unit
**Return on premium:** the option's profit or loss after the spread and fees, divided by what was paid for
it. Minus one is the whole premium lost. This is what DEC-0028's promotion test reads as "R after option
costs" for these rules: for a long option the premium is the risk.

It is a different unit from the paper record's R on the stock, and the page must never set the two side by
side as if they were one.

### 5. What is run, and what it may be used for
1. **The machinery, on the span already seen** (2026-03-03 to 2026-10-09, the cases of EXP-0023). This is
   exploratory by DEC-0028: it shows whether costs change the picture and proves the code. **It is not
   evidence** and cannot promote or drop a rule.
2. **The cases logged from each rule's `since` date on**, once there are enough. Only these feed the promotion
   test.

Reported for each rule and variant, at both spread widths: cases, cases left out, mean return on premium,
its 95% range resampled by case and by session, the same for each half of the cases in order, and the share
of cases that lost more than half the premium.

### 6. What would count against this design
- If the assumed widths prove far from what the live chain shows for these contracts (the page's contract
  pane shows the real spread today), the widths are wrong and a later record replaces them. Results under
  the old widths are kept and labelled.
- If five-minute bars are too sparse for the single names (many cases left out), the design does not fit
  them and the record says so, not a result.

## For the owner to decide before accepting

1. **The two expiries.** One day out and seven days out are my reading of "same-day and swing". If you
   usually buy the same-day expiry, variant N does not describe your trade and should say so on the page.
2. **The spread widths.** They are assumptions. Tighter widths flatter the rules; these are meant to be on
   the cautious side for liquid names at the money.
3. **Return on premium as the unit** for the promotion test.
4. **Whether to run step 1 at all**, given it is on a span already seen.
