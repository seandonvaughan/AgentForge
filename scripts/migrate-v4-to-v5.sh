#!/usr/bin/env bash
set -e
echo "AgentForge v4 -> v5 Migration"
echo "============================="
node --experimental-vm-modules packages/cli/dist/bin.js migrate "$@"
