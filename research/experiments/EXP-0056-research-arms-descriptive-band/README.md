# EXP-0056: a descriptive session-bootstrap band on two shadow arms' own trades

- Decision: DEC-0080 (PROPOSED 2026-11-25). Descriptive: no hypothesis, no trial, no family. Not a verdict.
- Frozen: `config.yaml`, with DEC-0080, before the band shows any number. A changed value is a new experiment.
- Data: the paper options document's `arms[].trades` for HYP-0046 and HYP-0047, sessions up to 2026-11-17 (the
  DEC-0059 cut). At most 9 sessions exist; the test of DEC-0030 section 6 needs 20.
- Shown: the Research arms page (`/research/arms`), live from each new document, once DEC-0080 is accepted.
- Results file: none. The page computes the band each time it is drawn; nothing is stored.
- HYP-0044 and HYP-0045 need the paired control trade, which the document does not carry: no band. Tag arms: sealed.
