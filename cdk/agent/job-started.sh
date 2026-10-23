#!/bin/sh
# grun: the job-started hook (cdk-github-runners runs it as the user hook of its own).
# Starts grun-agent's daemon, detached: the per-job sampler of the task's memory and
# CPU, and the reader of the runner's warnings and errors. It never fails the job.
#
# The runner's bundled Node runs it (externals/node<N>, the newest one there).
# RUNNER_TRACKING_ID is dropped so the runner's orphan clean-up at the end of the job
# does not kill the daemon before the job-completed hook has asked it for the peaks.
# Its output goes to its own file, never to the hook's pipes: the runner waits for
# those to close.
node=$(ls -d /home/runner/externals/node*/bin/node 2>/dev/null | sort -V | tail -n 1)
agent=/opt/grun/grun-agent.js
dir=${GRUN_AGENT_DIR:-${HOME:-/home/runner}/.grun-agent}
if [ -n "$node" ] && [ -x "$node" ] && [ -r "$agent" ]; then
  mkdir -p -m 0700 "$dir" 2>/dev/null || true
  env -u RUNNER_TRACKING_ID nohup "$node" "$agent" daemon </dev/null >>"$dir/agent.log" 2>&1 &
fi
exit 0
