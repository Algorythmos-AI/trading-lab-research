# SPEC-0001 — Warrior-style momentum methodology

The specification of record for the Gap-and-Go, Micro Pullback and Reversal strategies. Every threshold that
round 3 tests comes from here, and nothing else defines them.

| File | What it is |
|---|---|
| `source/` | The owner's material, exactly as supplied: spec text, indicators sheet, schemas v1/v2, JSON corrections and clarifications C1–C13 |
| `spec.yaml` | The normalised, machine-readable spec (v1.0.0), validated by `schema.json` |
| `traceability.csv` | One row per requirement: level, source, spec key, function, test, trials, status |
| `requirements.md` | Rendered from `traceability.csv` (`scripts/spec_docs.py`) |
| `conflicts.md` | Where sources disagree or a qualitative rule needed a number, and how each was resolved |

## How it's enforced

- `config/generated/*.yaml` are generated from `spec.yaml` by `python -m wt.specs.loader SPEC-0001 --write`.
- `tests/unit/test_spec_traceability.py` fails if:
  - the spec is invalid
  - a requirement names a spec key that doesn't exist
  - a MUST rule has no code or test
  - a generated config or `requirements.md` has drifted from the spec
- With `WT_SPEC_STRICT=1`, the same test also fails while any MUST rule is still `planned`.

## Lifecycle

- `draft` → `approved`: the owner reviews `spec.yaml`, `requirements.md` and `conflicts.md`. Approval is recorded as a decision, and `status: approved` is set.
- **After approval,** any change bumps the version and needs a new decision record.
- **Once DEC-0010 pre-registers the round-3 trials,** changing a rule that affects a trial also means a new pre-registration. The existing trial count stands.
