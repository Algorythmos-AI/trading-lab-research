# Active strategies

**Nothing in this folder trades.** The one file here, `B_intraday_momentum_qqqm.yaml`, is the frozen config of the
QQQ rule (strategy B), which DEC-0069 retired on 2026-11-20; its job `paper-b` is archived. It stays here only
because the status code lists this folder (`src/wt/ops/status.py`) and older decision records cite the path, until
the owner decides whether to move it to `research/retired_strategies/` ([its index](../retired_strategies/README.md)).

The desks that place paper orders today are configured in `config/`, not here:

- the options clone (`paper-o`): `config/options_clone.yaml`;
- Gap Hunter (`paper-s`): the `S` entries in `config/risk.yaml` and `config/trial_registry.yaml`.

See [docs/reference/glossary.md](../../docs/reference/glossary.md) for the names.
