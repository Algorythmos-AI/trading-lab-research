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
