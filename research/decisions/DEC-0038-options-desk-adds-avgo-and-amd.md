# DEC-0038: The options desk carries AVGO and AMD

- **Status: ACCEPTED on 2026-10-27.** The owner chose to add the two names on 2026-10-27, then chose "Go, both"
  on the plan for this change. The merge of the pull request that carries this line accepts it.
- **Written before any result exists for the new names.** AVGO and AMD have never been in the after-close edition, in
  the focus block, in the probation scorecard or in the options clone's names. The author has not looked at any
  paper P&L of the clone, or at any probation-rule result, while writing this record.
- **Amends** DEC-0028 in one rule only: which names the desk carries. The probation rules, their numbers and their
  verdict method are unchanged. The verdict keeps its original ten names (decision 2).
- **Depends on:** DEC-0005 (trial accounting), DEC-0028 (family O), DEC-0032 and DEC-0034 (how the clone chooses its
  names and their expiry), DEC-0035 (the focus-card plan is a display).

## Why

On Tuesday 27 October AVGO opened about 4% higher and went through last week's high. No card or list in the lab had
shown it, because the desk only carried the owner's ten names. Run on Monday's close, the focus pick's own score
would have ranked AVGO about second or third of the twelve names. That estimate assumes normal option volume,
because the desk has no option-volume history for AVGO. The owner asked for AVGO and AMD to be carried from now on.

## Decision

1. **Desk names** (`config/options_desk.yaml`, `names` and `contracts`): AVGO (313130367) and AMD (4391) are
   added after the ten. Both are public contract identifiers. The after-close edition, its focus pick and the host's
   open-interest job (`wt.options.live`) therefore cover twelve names.
2. **The DEC-0028 probation verdict keeps its original ten names.**
   - Scorecard rows for AVGO and AMD are kept, but listed apart from the ten.
   - They are not pooled into any probation rule's count, average R or verdict, so those results stay comparable
     with everything recorded since 2026-10-09.
   - Pooling them later is a new record.
3. **The options clone** takes the edition's focus names (DEC-0032), so AVGO or AMD may now be one of its names on
   a given day.
   - Its frozen rules are unchanged: the gates, the contract filters (ask at most $2.00, the delta, spread, volume and
     open-interest floors), the exits, the limits in `config/risk.yaml` key `O`, and the 15:10 flatten.
   - AVGO and AMD list options on Monday, Wednesday and Friday only. On the other days, the DEC-0034 `nearest`
     policy picks their next listed expiry.
   - DEC-0032 already reads every clone trade together, whatever its name. A trade in either name counts there like
     any other. The clone's journal names every trade, so its trades in these two names can be listed apart.
4. **The focus card warns about the expiry** (`dashboard/src/lib/focus-plan.ts`, `expiryNote`). On a Tuesday or a
   Thursday the card says no AVGO or AMD option expires that day, to take the next day's expiry and to size down.
   It also says their premiums near the money usually run over the premium cap. The thread's card
   (`skills/options-levels/scripts/focus.py`) prints the same words. Per DEC-0035 this is a display for the
   owner's own trades, not a lab strategy.

## Not changed

- The probation rules (HYP-0025 to HYP-0028) and their numbers.
- Every number in `config/options_clone.yaml` and `config/risk.yaml`.
- The radar's lists. These are the owner's research, kept apart from this repository.
- No hypothesis or experiment is added.
