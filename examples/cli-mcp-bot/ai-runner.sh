#!/usr/bin/env bash
# AI bot runner: play session (agent.mjs) -> LLM retro (retro.mjs) -> repeat.
# Configuration via environment or a git-ignored .env (see .env.example).
# State directory (conversation, doctrine, advisor, logs) via NEONETHACK_BOT_STATE.
cd "$(dirname "$0")"
STATE_DIR="${NEONETHACK_BOT_STATE:-$(pwd)/state}"
export NEONETHACK_BOT_STATE="$STATE_DIR"
mkdir -p "$STATE_DIR/logs"
echo "ai-runner started $(date -Is) (state: $STATE_DIR)" >> "$STATE_DIR/logs/runner.log"
while true; do
  if [ -f "$STATE_DIR/STOP" ]; then
    sleep 30
    continue
  fi
  BUDGET=$(cat "$STATE_DIR/step-budget" 2>/dev/null || echo 1000)
  echo "ai-runner: starting agent (budget $BUDGET) $(date -Is)" >> "$STATE_DIR/logs/runner.log"
  node agent.mjs "$BUDGET" >> "$STATE_DIR/logs/runner.log" 2>&1
  echo "ai-runner: agent exited code=$? $(date -Is)" >> "$STATE_DIR/logs/runner.log"
  echo "ai-runner: running retro $(date -Is)" >> "$STATE_DIR/logs/runner.log"
  node retro.mjs >> "$STATE_DIR/logs/runner.log" 2>&1
  sleep 2
done
