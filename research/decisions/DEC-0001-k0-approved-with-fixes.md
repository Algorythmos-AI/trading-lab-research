# DEC-0001 — K0 knowledge extraction approved, with funnel/management additions

- **Date:** 2026-09-27
- **Approved by:** owner (chat instruction: "after fixing go, go with your suggested G1 candidates")
- **Scope:** K0 deliverables in `knowledge/` plus the additions requested in review:
  price-preference discovery, time-of-day analysis, low-float thesis, RVOL evidence report
  (`selection_funnel_report.md`), pre-market ranking engine (`ranking_engine_spec.md`),
  trade-management catalog (`trade_management_catalog.md`), research registry (this folder),
  nightly human replay (plan rev 7).
- **Owner review scores:** architecture 8.5/10; methodology capture 6.5/10 before additions.
- **Build-order decision:** lean path — K0 → scanner → backtester → paper → human approval → live.
  OMS hardening, dashboards and extended observability are deferred until an edge is shown, except
  the minimum safety set required before any paper/live order (server-side stop, reconciliation,
  kill switch, flatten-by-close).
- **Open owner items:** real-time SIP data subscription (only needed before S1 goes live);
  S4 overnight holds (parked by default); password exposure in iCloud screenshots (owner to rotate).
