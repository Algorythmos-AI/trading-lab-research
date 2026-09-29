#!/bin/zsh
# Kept so agents installed before the job split keep working. While com.wt.forward is not installed,
# wt.ops.jobs runs the forward test after the session (and the weekly scorecard on Saturdays), as this script did.
exec "${0:A:h}/run_job.sh" paper-b "$@"
