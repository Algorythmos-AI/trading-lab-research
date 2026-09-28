#!/bin/zsh
# Nightly job (launchd 22:30 Sydney): (1) paper dress rehearsal of strategy B during the US session;
# (2) ~20 min after the close, the forward test of all frozen candidates on that session (DEC-0009).
cd /Users/samkalaliya/trading || exit 1
export PYTHONPATH=src
LOG=logs/paper_b_$(date +%Y%m%d).log
MODE=paper /usr/bin/caffeinate -is .venv/bin/python -c "from wt.live.runner_b import run; run()" >> $LOG 2>&1
# runner exits at the close (or immediately on non-trading days); wait for SIP data to age >15 min
/usr/bin/caffeinate -is sleep 1200
MODE=backtest /usr/bin/caffeinate -is .venv/bin/python scripts/forward_test.py >> logs/forward_$(date +%Y%m%d).log 2>&1
# Weekly scorecard: after the Friday US session (Saturday morning Sydney)
if [ "$(date +%u)" = "6" ]; then
  MODE=backtest .venv/bin/python scripts/weekly_scorecard.py >> logs/scorecard_$(date +%Y%m%d).log 2>&1
fi
