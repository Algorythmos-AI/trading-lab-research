# DEC-0081: News after the Benzinga history: fiscal.ai forward, an SEC EDGAR proxy for 2019–2025

- **Status: ACCEPTED on 2026-11-26.** The owner accepted it by merging the pull request that changed this line
  from PROPOSED (2026-11-26), with the three owner readings as set below. Phase 1 of EXP-0057 may now be run, once.
- **What it settles:**
  - the news source the repository uses from now on;
  - how the lost 2019–2025 history is partly replaced;
  - the frozen rule that turns SEC filings into a catalyst reading for DEC-0068's funnel;
  - the test that proxy must pass before it is used.
- **What it changes:** no live rule, no gate, no trial and no live job. DEC-0068 runs as it does. Its evidence stays
  the forward paper sessions until EXP-0057 says otherwise and a later record acts on it.
- **Depends on:** DEC-0003 (data sources, amended 2026-11-26), DEC-0010 (the development span and the holdout),
  DEC-0068 (the Gap Hunter funnel), EXP-0015a (the v3 headline classifier, 84% at decision level on Benzinga
  headlines).
- **Hypothesis:** HYP-0074 (a measurement, not a trial; no family).
- **Experiment:** EXP-0057.

## Why

- **What Alpaca changed.** Alpaca's support team confirmed on 2026-11-24 (ticket 402305) that the Benzinga news
  history was removed for every account and plan after a licensing change. It cannot be restored or exported.
  `/v1beta1/news` now serves fiscal.ai items only, the first at 2026-04-29T02:31Z. There is no source parameter, and
  no other endpoint.
- **What it broke.**
  - Every pool built now for 2019 to 2025 has `headlines_n = 0`.
  - So DEC-0068 records that its rule "cannot be checked on 2019 to 2025".
  - EXP-0015's Set P counts are upper bounds, and Set F was never run.
- **The owner's choice (2026-11-26):** SEC EDGAR, which is free, over a paid Benzinga feed. EDGAR sees filings, not
  press coverage, so it can stand in for part of the headline reading only. This record says which part, and how to
  test that before anything is counted with it.

## Decision

1. **The forward source is fiscal.ai through Alpaca.**
   - Every item is copied daily into the private repository `Algorythmos-AI/trading-news-archive` by
     `scripts/news_archive.py` (`docs/runbooks/news-archive.md`), from its first item on.
   - Headlines stay RESTRICTED and never enter this repository, which is public.
   - The owner directed the GitHub copy on 2026-11-26. It is for his own research and is never redistributed.
2. **The 2019–2025 stand-in is SEC EDGAR filings**, read from `data/edgar/events.parquet`
   (`wt.data.edgar_events`, built 2026-11-26) and keyed on each filing's acceptance time. That time is true UTC,
   converted to New York (discovery note R1), never the filing date. It is called the **EDGAR proxy**, never "Set F"
   and never a headline.
3. **The window** is the pool's own window: from 16:00 New York time on the previous session to the 09:25 cut of the
   session, judged on acceptance time.
4. **The proxy table (frozen).** For each (name, session), the first matching row wins, in this order:

   | Order | Proxy category | Filings in the window | Reads as, in DEC-0068 |
   |---|---|---|---|
   | 1 | buyout | SC 14D9, SC14D9C, PREM14A or DEFM14A filed under the name's CIK; or SC TO-T, SC TO-T/A, SC TO-C, 425 or SC 13E3 whose EDGAR index page names the name's company "(Subject)" | the hard buyout rejection (`excluded`, `buyout_offer`) |
   | 2 | offering | 424B1, 424B4 or 424B5 filed by the name | a headline that does not qualify (+0.05) |
   | 3 | earnings | 8-K or 8-K/A with item 2.02 | the qualifying catalyst `earnings_release`, scored as the base score scores it |
   | 4 | other | 8-K or 8-K/A with item 7.01 or 8.01 | a headline that does not qualify (+0.05) |
   | 5 | none | none of the above | no headline (the 2.5 relative-volume and 100,000-share path) |

   Why each choice was made, from the discovery note (`docs/notes/edgar-discovery-2026-11.md`), which was written
   before this record:
   - **Shared deal filings need a role check.** SC TO-T, SC TO-T/A, SC TO-C and 425 are listed under both the
     bidder's and the target's CIK, under one accession. Without the index page's role they would flag acquirers.
     SC 13E3 is shared on 4% of filings, so it gets the same check. SC 14D9, SC14D9C and the merger proxies appeared
     only under the target in all ten deals read.
   - **Announcement-day forms are added.** SC TO-C and SC14D9C are filed on the day a tender offer is announced,
     which is the day a buyout headline would have stopped a name. They are added to the store's kept forms: a
     re-crawl of about an hour, in the same pull request as the annotator.
   - **Left out, as noisy:** DEFA14A (every proxy season files it) and 8-K item 1.01 (most material agreements are
     not deals).
   - **Left out, as not dilution:** 424B2, which is 52% of all rows and almost all banks' structured notes, and
     424B3 (resales).
   - **Earnings:** item 2.02 has a median of 4 filings per company-year, as earnings should.
   - **Not visible to the proxy:** FDA decisions, clinical results, analyst upgrades, rumours and other breaking news.
     The proxy undercounts catalysts, so it moves names from "qualifying" or "other" to "none". Every count that uses
     it says so.
5. **Names the proxy cannot read are "unknown", never "none".** Unknown means one of the following:
   - the symbol has no CIK in today's map;
   - it is `map_suspect` (the mapped CIK filed nothing that year, or its names disagree with Alpaca's asset name;
     4.6% of mapped pairs in 2019, falling to 1.3% in 2025);
   - a needed index page could not be read.

   EXP-0057 drops unknown name-days from the agreement test. In counts it reports them on their own line, and gives
   each count twice: with them read as "none", and with them left out.
6. **The proxy must pass a test first** (EXP-0057, phase 1). It is measured on sessions where both fiscal.ai headlines
   and EDGAR exist, as agreement with what classifier v3 makes of those headlines. That is agreement with v3, not
   accuracy: v3 itself scored 84% on Benzinga.
   - **Pass:** buyout recall of at least **0.80** and earnings recall of at least **0.80**, each on at least **20**
     name-days. Recall is the share of v3's buyout (or earnings) name-days the proxy also marks.
   - **Not decidable:** either measure has fewer than 20 name-days. Phase 2 then waits for a dated note here from the
     owner.
   - **Fail:** phase 2 is not run. The proxy is not used for DEC-0068, and a new record decides what is.
7. **Phase 2 counts only, and only on the development span.**
   - **When it runs:** only after a pass.
   - **What it reads:** DEC-0068's funnel with the EDGAR proxy in place of the headline columns, over the development
     span 2019-01-02 to 2025-09-25. The holdout (2025-09-26 to 2026-09-25, DEC-0010) is not read.
   - **What it reports:** the funnel and entry counts per year that `scripts/gap_hunter_counts.py` reports, at US$600.
   - **Limits:** no R, no P&L, no exit, no price. A result needs another record.

## Owner readings (each is his to change before acceptance)

1. **Phase 1 reads catalyst columns from the holdout span (set here).** The sessions with both sources are
   2026-04-30 to 2026-11-25, and most of them (2026-04-30 to 2026-09-25) fall inside DEC-0010's holdout. Phase 1
   reads only, for those sessions:
   - which names the pool kept;
   - their headline category and time;
   - their filings.

   It reads no price, entry, exit or result, and runs no trial, so the holdout's one registered run is not spent.
   The alternative is to use only the post-holdout forward sessions (2026-09-28 onward, about 40). That would very
   likely give fewer than 20 buyout name-days, which is not decidable.
2. **The thresholds (set here):** 0.80, 0.80 and 20, as the approved plan proposed.
3. **The licence:** whether keeping the fiscal.ai copy in a private GitHub repository is within Alpaca's market-data
   terms. Alpaca's terms are the owner's to read.

## Disclosure (what was seen before this record)

- **The forward funnel.** DEC-0068's step counts on its forward pools were seen, as DEC-0068 records.
- **Set P.** EXP-0015's Set P trade counts at relaxation levels 0–3 on 2019–2025 were seen (counts only, no R).
- **EDGAR.** The discovery note's form volumes per year, the 10 deals' filing lists, and the map-suspect rates of pool
  (symbol, year) pairs. Those rates were computed from symbols and years only, with no pool outcome read.
- **fiscal.ai.** Daily item counts from 2026-04-28 to 2026-11-25 and the `source` field. No headline was read for
  this record.
- **Not seen:** any agreement figure between EDGAR and headlines, any 2019–2025 Gap Hunter count, any R.

## Dated notes

### 2026-11-26: phase 1 closes the EDGAR proxy; phase 2 is not run (owner's note)

EXP-0057 phase 1 ran once (#685). The report is `phase1_report.json` and `.md`.

- **The frozen rule's reading is not_decidable.** Buyout recall rested on 14 name-days, below the minimum of 20.
- **The owner reads the earnings half as decisive.** Earnings recall was 74.5% (536 of 719), with a Wilson 95%
  interval of 71.2% to 77.6%. The whole interval lies below 0.80, on 36 times the minimum n. The hypothesis needs both
  halves to reach 0.80, so no number of further buyout name-days could make it pass.
- **The buyout half gives no reason to hope either.** The proxy found 3 of v3's 14 buyout name-days (21.4%), and 3 of
  the 35 it marked as buyouts were buyouts to v3 (8.6%).
- **The secondary comparison on the Benzinga pools** (2018-12 and 2025-09, reported only) had too few cases to read.

What follows:

1. **Phase 2 is not run, and the proxy is not used for DEC-0068.** The pre-registered verdict stays not_decidable.
   It is not a fail under point 6. Closing the proxy is the owner's choice in this note, made after that result.
   Point 6 would have given a fail the same effect. HYP-0074 is marked falsified on the owner's reading of the
   earnings half.
2. **DEC-0068's line stands.** "This rule cannot be checked on 2019 to 2025" still holds. Its evidence stays the
   forward paper sessions.
3. **The rest of this record stands.**
   - fiscal.ai remains the forward source (points 1–3).
   - The private archive keeps running.
   - The EDGAR event store stays in `data/edgar` as data.
4. **A later proxy needs a new record.** Any changed table, window or threshold is a new HYP and EXP, registered
   before any count. This note proposes none.
5. **What this run suggests, not tested.** The median earnings filing came 74 minutes before the first qualifying
   headline. Some of the misses may therefore be timing rather than coverage. A new record would have to test that
   before it is relied on.
