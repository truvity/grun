#!/bin/sh
# grun: the job-completed hook. Stops grun-agent's daemon, prints the job's peaks as a
# `::notice::` line, and waits (at most 20 seconds) for its last export. It never fails
# the job.
node=$(ls -d /home/runner/externals/node*/bin/node 2>/dev/null | sort -V | tail -n 1)
agent=/opt/grun/grun-agent.js
if [ -n "$node" ] && [ -x "$node" ] && [ -r "$agent" ]; then
  "$node" "$agent" finish || true
fi
exit 0
