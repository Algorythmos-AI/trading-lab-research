#!/bin/zsh
# SPEC-0001 pre-market routine (dry run, no broker calls). launchd starts it at 21:30 Sydney; the script waits
# until 07:55 ET itself (zoneinfo), so AU and US daylight-saving changes need no schedule edits.
cd /Users/samkalaliya/trading || exit 1
export PYTHONPATH=src
LOG=logs/routine_$(date +%Y%m%d).log
/usr/bin/caffeinate -is .venv/bin/python scripts/premarket_routine.py >> $LOG 2>&1
