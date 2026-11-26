# DEC-0003 — Data sources and known limitations (G0 findings, 2026-09-27)

| Need | Source | Verified | Limitation |
|---|---|---|---|
| Historical minute/daily bars | Alpaca SIP (free) | back to 2016 | last 15 min forbidden; an end *date* of today counts as recent → always end at now−16 min |
| Live-equivalent signal bars | Alpaca IEX (free) | history starts mid-2020 (empty 2020-06-01, present 2020-08-03) | thin for small caps → S1 live signals need SIP subscription |
| Universe incl. delisted | Alpaca assets active+inactive (NASDAQ/NYSE/AMEX) | 19,173 inactive (16,304 OTC) | **inactive list incomplete** (TWTR, SIVB, BBBY, FRC absent though bars exist) → residual survivorship bias, flatters long momentum; disclosed in every G1 report |
| Float proxy | SEC EDGAR XBRL frames `dei:EntityCommonStockSharesOutstanding`, known from as-of date + 5 days | 150,921 rows, 10,072 CIKs, 10,853 tickers mapped (425 by name) | shares outstanding ≥ float; unmapped tickers → float unknown (score 0) |
| Catalysts | Alpaca News (Benzinga) | back to 2019 | keyword classifier; accuracy check pending (target ≥85%) |
| Calendar | Alpaca /v2/calendar | half-days present (e.g. 2019-11-29 close 13:00) | — |
| ETF track | SPYM (SPLG renamed), QQQM | both active & tradable on Alpaca | SPYM pre-rename history to verify before G1 |
| Halts (historical) | none free | — | inferred from bar gaps; live via Nasdaq halt feed later |

## Addendum (2026-09-27, G0 checks)
- **IEX history starts 2020-07-23** (binary search on AAPL daily). Before that, signal bars use SIP.
- **SPYM** history is continuous back to 2019 (Alpaca carries SPLG history under SPYM after the rename) → ETF track can use SPYM directly.
- **QQQM** launched Oct 2020 → no earlier bars. Strategy A on the Nasdaq leg uses QQQ-signal/QQQ-price-ratio mapping for 2019–2020-10, QQQM after; reported separately.
- Scanner cost optimisation: NBBO quotes fetched lazily (only for symbols passing all non-spread filters).
- **Webull AU fees (checked 2026-09-27):** US stocks/ETFs **$0 commission since April 2026** (previously
  0.025%, min $1 — which would have erased small edges at US$600). Model keeps SEC/FINRA-style sell fees;
  FX conversion is a one-off on deposit. Sources: webull.com.au FAQ "How much does it cost to trade?",
  AAP/PR Newswire release 2026-04-01. Re-verify before live (G4).

## Amendment (2026-11-26): the news history before 2026-04-29 is gone

The **Catalysts** row above is no longer true. It is left as written in 2026-09; this amendment replaces it.

- In late September 2026 `/v1beta1/news` returned Benzinga items dated 2018 and 2025. From 2026-11-19 it returned
  nothing dated before 2026-04-29, and every item carried `"source": "fiscal.ai"`.
- Alpaca support confirmed on 2026-11-24 (ticket 402305) that Alpaca replaced Benzinga with fiscal.ai and removed the
  Benzinga history for every account and plan, after a licensing change. It cannot be restored or exported, there is
  no source parameter (`source=` is refused with HTTP 400), and no separate history endpoint exists.
- Effect: pools built for 2019 to 2025 carry no headlines (`headlines_n = 0`), so no rule that needs a headline can be
  checked on those years from this source. DEC-0068 already says so for the Gap Hunter funnel. Pools built in
  2026-09 for 2018-12 and 2025-09 still hold the Benzinga headlines they were built with.
- From 2026-11-26 the API's news is copied by `scripts/news_archive.py` (`wt.data.news_archive`), from its first
  item (2026-04-29T02:31Z, the evening of 2026-04-28 in New York) on, into the PRIVATE repository
  `Algorythmos-AI/trading-news-archive` (`docs/runbooks/news-archive.md`), so a later change of provider cannot
  remove it again. Headlines stay RESTRICTED: they never enter this repository, which is public. The owner directed
  the copy to GitHub on 2026-11-26; it is kept for his own research and never redistributed.
- The classifier's accuracy (EXP-0015a, 84% at decision level) was measured on Benzinga headlines only. It has not
  been measured on fiscal.ai headlines.
- A partial stand-in for 2019 to 2025 from SEC EDGAR filings is proposed separately, in its own records, before any
  count is taken.
