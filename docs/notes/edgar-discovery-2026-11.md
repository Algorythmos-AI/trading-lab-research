# EDGAR discovery for the 2019–2025 catalyst proxy (2026-11-26)

Point-in-time note: step 2 of the post-Benzinga news plan, written before any record. It settles three risks named
in that plan (R1–R3) with evidence, and reports what `scripts/build_edgar_events.py` built. Data only: nothing here is
counted against the candidate pools, and no R, P&L or return was computed or looked at. The records that will use it
(a decision, a hypothesis and an experiment) come later and are not numbered here.

Code: [`src/wt/data/edgar_events.py`](../../src/wt/data/edgar_events.py),
[`scripts/build_edgar_events.py`](../../scripts/build_edgar_events.py). Output (git-ignored, Mac only):
`data/edgar/events.parquet`, `data/edgar/cik_meta.parquet`, `data/edgar/cik_form_years.parquet`.

## R1: `acceptanceDateTime` is true UTC, not ET marked "Z"

The plan expected the value to be Eastern time with a wrong "Z". It is not: it is UTC, and converting it to
America/New_York gives the time the EDGAR index page shows as "Accepted".

| Accession | Form | Submissions JSON | Index page "Accepted" (ET) | Offset |
|---|---|---|---|---|
| 0000320193-26-000024 | 8-K 2.02 | 2026-11-02T21:30:23Z | 2026-11-02 16:30:23 | −5 h (EST) |
| 0000320193-26-000018 | 8-K 2.02 | 2026-07-30T20:30:28Z | 2026-07-30 16:30:28 | −4 h (EDT) |
| 0000320193-24-000081 | 10-Q | 2024-08-01T22:03:34Z | 2024-08-01 18:03:34 | −4 h (EDT) |
| 0001140361-25-025275 | 8-K 5.02 | 2025-07-09T01:18:13Z | 2025-07-08 21:18:13 | −4 h (EDT) |
| 0000320193-19-000007 | 8-K 2.02 | 2019-01-29T21:30:18Z | 2019-01-29 16:30:18 | −5 h (EST) |
| 0001193125-22-275080 | SC TO-C | 2022-11-01T21:25:17Z | 2022-11-01 17:25:17 | −4 h (EDT) |

The pattern is visible in the data too: Apple's earnings 8-K, released at 16:30 ET every quarter, reads 20:30Z in
summer and 21:30Z in winter from 2015 to 2026. Two of the rows also show that the filing date is not the acceptance
date: a filing accepted after 17:30 ET carries the next business day's `filingDate` (the 10-Q above). A window must
key on `accepted_at_et`, never on `filing_date`.

`edgar_events.accepted_et` converts UTC to ET; `tests/unit/test_edgar_events.py` pins it on both sides of DST and on
the repeated 01:30 of the November fall-back.

## R2: who lists a deal filing, and can the subject be told from the acquirer

Ten known 2019–2025 deals, target and acquirer CIKs both read (forms since 2018-06; counts are of filings):

| Deal (year, type) | Target lists | Acquirer lists | Same accession under both |
|---|---|---|---|
| Sanofi / Provention Bio (2023, tender) | SC TO-T 1, SC TO-T/A 3, SC 14D9 1, SC 14D9/A 4, SC TO-C 2, SC14D9C 1 | SC TO-T 6, SC TO-T/A 20, SC TO-C 11 | 6: SC TO-T, SC TO-T/A, SC TO-C |
| J&J / Abiomed (2022, tender) | SC TO-T 1, SC TO-T/A 5, SC 14D9 1, SC 14D9/A 5, SC TO-C 3, SC14D9C 7 | SC TO-T 2, SC TO-T/A 9, SC TO-C 6, 425 58 | 9: SC TO-T, SC TO-T/A, SC TO-C |
| AMD / Xilinx (2020, stock) | 425 10, DEFM14A 1 | 425 5 | 4: 425 |
| Broadcom / VMware (2022, stock) | 425 59, DEFM14A 1 | 425 56 | 56: 425 |
| Chevron / Hess (2023, stock) | 425 31, DEFM14A 1 | 425 58 | 16: 425 |
| Exxon / Pioneer (2023, stock) | 425 46, DEFM14A 1 | 425 33 | 22: 425 |
| Microsoft / Activision (2022, cash) | PREM14A 1, DEFM14A 1 | none | 0 |
| Musk / Twitter (2022, cash, private buyer) | PREM14A 1, DEFM14A 1 | (no public CIK) | — |
| Pfizer / Seagen (2023, cash) | PREM14A 1, DEFM14A 1 | SC TO-T 1, SC TO-T/A 8 (none for Seagen) | 0 |
| AbbVie / Allergan (2019, scheme) | PREM14A 1, DEFM14A 1 | none | 0 |

What this shows:

- **SC TO-T, SC TO-T/A, SC TO-C and 425 are listed under both CIKs**, the filer's and the subject's, with one
  accession. A name whose submissions show an SC TO-T may be the bidder, not the target: J&J's list carries the
  Abiomed offer, and Pfizer's carries a tender offer that is not the Seagen deal. Without a role, those forms flag acquirers.
- **The submissions JSON carries no role field.** The filing's index page does: for 0001193125-22-275080 it names
  "JOHNSON & JOHNSON (Filed by)" and "ABIOMED INC (Subject)"; for the 425s 0001140361-22-022251 and
  0000950103-23-014886 it names Broadcom and Exxon "(Filed by)", VMware and Pioneer "(Subject)". So the subject can
  be told from the acquirer, at the cost of one index-page request per shared filing. Only the few rows that fall in a
  pool window need it, so step 4 can fetch those pages at annotation time instead of crawling roles for every filing.
- **SC 14D9 (the target's response) and PREM14A/DEFM14A (the merger proxy) appear only under the target** in all ten
  deals. They need no role check. They come days to weeks after the announcement, though, so they mark a name as
  "in a deal" rather than catching the announcement day.
- **The announcement day is mostly in forms the store does not keep.** On the day a deal is announced the target
  files SC TO-C / SC14D9C (tender) or DEFA14A (merger), with the 8-K item 1.01 (kept, under 8-K). The plan's form
  list misses SC TO-C, SC14D9C, SC 14D9/A and DEFA14A; `cik_form_years.parquet` counts them per CIK per year, so
  their volume is known without a second crawl. Whether to add them is for the record that freezes the proxy table;
  adding them later is a re-crawl of about an hour. DEFA14A is noisy (every annual proxy season files it).
- Offerings (424B1–B5) are listed only under the issuer. The large banks' 424B2s are structured notes, not equity
  dilution (JPMorgan alone has about 114k since 2018-06), so a dilution proxy should read 424B2 with care.

## R3: ticker reuse and map-suspect rate per year

Method: every (symbol, year) pair in `data/candidates/*.parquet` (12,255 pairs), mapped through today's
`data/edgar/ticker_cik.parquet`, then flagged when either check fails:

- **no filing that year**: the mapped CIK filed no form at all that year (`cik_form_years.parquet`, every form). Here
  this is nearly the same set as "the CIK's first filing comes after that year".
- **name disagrees**: Alpaca's asset name matches neither the CIK's EDGAR name nor any of its former names (token
  subset, or Jaccard of 0.5 or more after normalising, with apostrophes stripped).

`map_suspect` is either flag. Rates are of mapped pairs. Counts and rates only: no pool outcome was read.

| Year | Pairs | Mapped | No filing that year | Name disagrees | map_suspect | n |
|---|---|---|---|---|---|---|
| 2018 (Dec only) | 54 | 94.4% | 2.0% | 3.9% | 5.9% | 3 |
| 2019 | 1,126 | 92.8% | 3.1% | 1.6% | 4.6% | 48 |
| 2020 | 1,825 | 97.7% | 2.3% | 1.7% | 3.9% | 70 |
| 2021 | 1,620 | 98.3% | 1.6% | 1.5% | 3.1% | 50 |
| 2022 | 1,759 | 99.3% | 1.4% | 1.1% | 2.5% | 44 |
| 2023 | 1,785 | 99.7% | 1.3% | 1.3% | 2.6% | 46 |
| 2024 | 1,936 | 99.8% | 0.6% | 0.8% | 1.4% | 27 |
| 2025 | 2,073 | 99.9% | 0.4% | 0.9% | 1.3% | 27 |
| 2026 (to 09-29) | 77 | 100% | 0.0% | 1.3% | 1.3% | 1 |
| all | 12,255 | 98.6% | 1.4% | 1.3% | 2.6% | 316 |

How to read it:

- **"No filing that year" is the real reuse signal**, and it falls as the map's "today" gets nearer: 3.1% in 2019, 0.4%
  in 2025. A sample shows true reuse (AAC and AKTS in 2019 were other companies than today's Ares SPAC and Aktis
  Oncology). It also catches the same business under a new CIK: APA (the 2021 holding company over Apache) and AU
  (AngloGold re-domiciled). Those are not reuse, but their events before the new CIK sit under the old CIK, which
  today's map does not reach, so they are rightly excluded.
- **"Name disagrees" is mostly spelling noise.** Both sides are today's names, so it can only catch a map error, never
  reuse. A sample shows foreign issuers whose EDGAR name is an English translation (Banco Macro = "Macro Bank Inc.",
  CEMIG = "Energy Co of Minas Gerais") and punctuation. It is kept in `map_suspect` because it costs about 1% of
  pairs, but it should not be read as a reuse rate.
- Unmapped pairs (1.4% overall, 7.2% in 2019) are names delisted before the map was built and never name-matched.
  They have no EDGAR events at all and must count as "unknown", not as "no catalyst".
- The same delisting gap hits deals: an acquired target leaves today's ticker map, so its own filings are mostly not
  in this store. Within the store, the share of filings listed under two or more mapped CIKs is SC TO-T/A 21.7%,
  SC TO-T 16.9%, 425 12.1%, SC 13E3 4.0%, and 0.2% or less for every other form. Those are understated for the same
  reason.

These rates come from a measurement script that was not committed; step 4's annotator implements the flag as
`map_suspect` with its own tests.

## What was built

`PYTHONPATH=src .venv/bin/python scripts/build_edgar_events.py --data ~/trading/data --summary` on the Mac,
2026-11-26 12:25–13:55 AEDT (about 1 h 30 min at 5 requests/s). All 8,383 mapped CIKs answered (`cik_meta.status` is
"ok" for every one, with no failed older page), and 7,113 of them have at least one kept filing. Sizes: events 20 MB,
meta 0.5 MB, form counts 1.1 MB, checkpoints 25 MB.

`events.parquet` has 1,085,569 rows (cik, accession) and 1,081,133 unique filings. Rows per form per acceptance year
(ET). 2018 is June to December only, and 2026 runs to 2026-11-26:

| Form | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | all |
|---|---|---|---|---|---|---|---|---|---|---|
| 424B1 | 14 | 23 | 37 | 70 | 28 | 31 | 45 | 19 | 14 | 281 |
| 424B2 | 17,560 | 33,051 | 43,574 | 59,008 | 58,064 | 64,456 | 85,313 | 96,912 | 111,616 | 569,554 |
| 424B3 | 1,984 | 3,413 | 3,805 | 3,714 | 5,115 | 5,202 | 5,741 | 5,843 | 5,707 | 40,524 |
| 424B4 | 174 | 279 | 451 | 658 | 228 | 303 | 420 | 583 | 452 | 3,548 |
| 424B5 | 834 | 1,799 | 2,570 | 2,411 | 1,447 | 1,800 | 2,500 | 3,010 | 2,626 | 18,997 |
| 425 | 1,163 | 2,162 | 2,550 | 5,882 | 2,551 | 2,375 | 1,723 | 3,320 | 3,912 | 25,638 |
| 8-K | 21,928 | 41,976 | 47,837 | 48,624 | 46,307 | 48,833 | 51,124 | 54,665 | 52,948 | 414,242 |
| 8-K/A | 570 | 1,028 | 1,097 | 1,170 | 1,114 | 1,167 | 1,185 | 1,211 | 1,206 | 9,748 |
| DEFM14A | 20 | 63 | 98 | 163 | 88 | 32 | 49 | 44 | 136 | 693 |
| PREM14A | 14 | 57 | 55 | 101 | 62 | 24 | 38 | 41 | 94 | 486 |
| SC 13E3 | 3 | 6 | 17 | 22 | 12 | 9 | 9 | 5 | 21 | 104 |
| SC 14D9 | 6 | 10 | 48 | 37 | 26 | 11 | 13 | 6 | 23 | 180 |
| SC TO-T | 14 | 23 | 60 | 37 | 39 | 31 | 16 | 33 | 31 | 284 |
| SC TO-T/A | 81 | 98 | 290 | 143 | 147 | 137 | 91 | 167 | 136 | 1,290 |
| all | 44,365 | 83,988 | 102,489 | 122,040 | 115,228 | 124,411 | 148,267 | 165,859 | 178,922 | 1,085,569 |

Checks:

- **8-K item 2.02, the earnings proxy:** a median of 4.0 and a mean of 4.11 per CIK per year over 2019–2025, with
  71% of CIK-years at exactly 4, as the plan expected. By ET hour of acceptance, 16:00–17:59 holds 65k and 06:00–08:59
  holds 41k, the two usual release windows.
- **Near-miss forms, counted but not kept** (filings per year, 2019–2025, from `cik_form_years.parquet`):
  - SC TO-C: 90–143
  - SC14D9C: 7–54
  - SC 14D9/A: 6–162
  - DEFA14A: 3.2k–5.6k
  - 424B7: 107–229
  - SC TO-I (issuer tender, not a buyout): 69–123
- **424B2 is 52% of all rows**, almost all of it banks' structured notes, so it needs care as a dilution proxy (R2).
- **Resume:** the build checkpoints every 50 CIKs. `tests/unit/test_edgar_events.py` kills a build mid-run with a
  throttle and shows that the rerun refetches nothing finished and gives the same table.
