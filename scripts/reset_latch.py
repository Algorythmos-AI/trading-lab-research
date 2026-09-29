"""Clear the paper-B virtual account's loss latch (OWNER ONLY). Usage: make reset-latch REASON="why it is safe"."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wt.core.config import DATA_DIR  # noqa: E402
from wt.risk.virtual_account import reset_latch  # noqa: E402

if __name__ == "__main__":
    reason = " ".join(sys.argv[1:]).strip()
    if not reason:
        sys.exit('usage: make reset-latch REASON="why it is safe to resume"')
    va = reset_latch(DATA_DIR / "live" / "virtual_account.json", reason)
    print(f"latch cleared; recorded: {va.latch_history[-1]}")
