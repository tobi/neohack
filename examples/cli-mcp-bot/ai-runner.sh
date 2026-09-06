#!/usr/bin/env bash
# AI bot runner: play session (agent.mjs) -> LLM retro (retro.mjs) -> repeat.
# Configuration via environment or a git-ignored .env (see .env.example).
cd "$(dirname "$0")"
echo "ai-runner started $(date -Is)" >> logs/runner.log
while true; do
  if [ -f STOP ]; then
    sleep 30
    continue
  fi
  BUDGET=$(cat step-budget 2>/dev/null || echo 1000)
  echo "ai-runner: starting agent (budget $BUDGET) $(date -Is)" >> logs/runner.log
  node agent.mjs "$BUDGET" >> logs/runner.log 2>&1
  echo "ai-runner: agent exited code=$? $(date -Is)" >> logs/runner.log
  echo "ai-runner: running retro $(date -Is)" >> logs/runner.log
  node retro.mjs >> logs/runner.log 2>&1
  sleep 2
done
