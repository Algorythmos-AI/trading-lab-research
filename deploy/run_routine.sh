#!/bin/zsh
# Kept so agents installed before the job split keep working.
exec "${0:A:h}/run_job.sh" routine "$@"
