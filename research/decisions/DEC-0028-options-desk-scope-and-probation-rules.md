# DEC-0028: Options desk, its scope, its data, and the four rules on paper probation

- **Status: ACCEPTED on 2026-10-11.** The owner accepts it by merging the pull request that carries this
  status line. He approved the plan this record comes from on 2026-10-10 and said "go" to this step on
  2026-10-11.
- **Depends on:** DEC-0005 (every configuration tried counts as a trial), ADR 0001 (the dashboard holds no
  broker keys).
- **Does not amend** any earlier record. The stock strategy, the crypto desk and their trial counts are
  untouched.
- **Date drafted:** 2026-10-11.

## Why

The Options page has shown ten names' levels and four entry rules "on probation" since 2026-10-09. The code
that builds it ran in a cloud project and had no record here: no hypothesis, no experiment, no decision. The
rules' backtest figures on the page were worked out there, before anything was registered.

The engine is now in this repository (`wt.options.levels`, `wt.options.rules`, `wt.options.edition`), moved
with its behaviour unchanged. This record says what the desk is, registers the four rules as they stand, and
turns "the promotion test" from a sentence on the page into a rule that can be checked.

## Decision

### 1. What the desk is
- **Descriptive.** It shows levels, option prices, costs and the rules' own record. It never says buy or sell,
  and nothing in it places, stages or suggests an order.
- **For one kind of trade:** a long single call or put, same-day or held for days. No spreads, no selling
  premium.
- **Paper only.** The positions it shows are those of a second paper account, read with GET requests. The
  owner places those trades by hand; no code in this repository does.

### 2. Where its numbers come from
| What | Source | Built by |
|---|---|---|
| Levels, zones, expected move, the rules' paper record | The broker's official daily and hourly bars and its implied-volatility snapshot, pulled after the close | `wt.options.edition`, run by the after-close routine |
| Live prices, option quotes | A market-data feed, option quotes 15 minutes delayed | the site, on request |
| Paper positions, open interest | The second paper account and public contract data | `wt.options.live` on the host |

Real pulls never enter this repository. Tests use seeded synthetic bars.

### 3. The four rules are registered as they stand, after their results were seen
HYP-0025 to HYP-0028 register the four rules of `wt.options.rules`, one each, as trial family **O**.

This is not a clean pre-registration and does not pretend to be one. The rules were chosen, and their
results seen, in the cloud project before this record existed. Each hypothesis file carries those figures
under `seen_before_registration`. None of the four showed an edge there: every 95% range for mean R
straddles zero.

Consequences:
- **Nothing from that span is evidence.** A rule is judged only on paper cases logged from its `since` date
  on.
- **The trial count for family O is 12.** The study behind the rules tried the four entries in three
  variants: the same-day exit that is registered, a trend filter, and an overnight hold. That is twelve
  configurations. The count comes from the study's own notes, not from re-running it, and it is a floor: if
  the replication in section 6 finds more, a later record raises it.
- **The rule is the code.** A rule means what `wt.options.rules.probation_triggers` does at the commit that
  merges this record. Four behaviours the port's review found are therefore part of the registered rules,
  not bugs to be fixed quietly:
  1. a bar that only touches the two-risk target does not score it;
  2. a session that opens beyond the prior high or low is scored as a break on its first hourly bar;
  3. a reclaim or rejection needs the hourly close before it to be beyond the level;
  4. zones can overlap when a supply or demand band is involved (this affects the page's "big zone" marks,
     not the rules).

  Changing any of them changes the rule: it is a new trial, with a new hypothesis and a row in the registry.

### 4. The promotion test
A rule leaves probation only when all of these hold, on cases logged from its `since` date:
1. **At least 30 paper cases.**
2. **At least 20 sessions** since the first of them.
3. **The 95% range of mean R, after option costs, lies wholly above zero** (bootstrap, as
   `wt.backtest.stats.bootstrap_ci` computes it).
4. **Mean R after option costs is above zero in each half** of the cases, taken in order.

Then, and only then, a decision record may change its `status` in `config/options_rules.json`.

**No rule can pass today**, whatever its paper record says: the record is in R on the stock, before the cost
of the option. Conditions 3 and 4 need an option-priced replay, which does not exist. It will be its own
registered experiment. Until then the page keeps saying what it says now: no rule is proven, and none is a
signal to trade.

A rule is dropped by the `falsified_if` clause of its hypothesis.

### 5. What the page may claim
- The four backtest figures stay labelled as exploratory, with their span.
- The paper record stays labelled "R on the stock, no option costs".
- "Promotion needs 30 paper cases, a range above zero after costs, both halves and 4 weeks live" stays, and
  now means section 4.

### 6. What comes next, each with its own approval
- **A replication experiment**, numbered when it is run: the four rules on hourly bars for the same ten
  names and span, from this repository's code, on data kept out of git. It reports counts and R, compares
  them with the figures seen before, and counts the variants the original study tried.
- **The routine switch.** The after-close routine keeps running its own copy until a shadow night shows
  this repository's code writing the same edition from the same pulls. The owner approves the switch.
- **Edition format 2.** `edition_format` in `config/options_desk.yaml` stays 1 until the owner flips it,
  after the shadow night has confirmed the unit of realised volatility and the windows behind the volume
  average.
- **An option-priced replay**, registered before any of its results is viewed.

## What this record does not do
It runs nothing, changes no code and promotes nothing. The engine's behaviour, the edition sent tonight and
the page are the same before and after it.
