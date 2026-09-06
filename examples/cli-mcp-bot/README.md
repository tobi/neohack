# cli-mcp-bot — an LLM plays NetHack through native MCP HTTP

An autonomous bot that plays NetHack using the neonethack C engine directly.
A Vercel AI SDK agent drives the installed native MCP HTTP target
(`~/.local/bin/neohack-mcp --http`) — no browser or stdio bridge involved.

```
ai-runner.sh ──> agent.mjs (one session: STEP_BUDGET model steps)
                  │    └─ every tool result is augmented with an
                  │      ADVISOR suggestion from advisor.mjs (heuristic
                  │      decision tree); the model may override it
                  └─> retro.mjs (LLM reviews the session log, improves
                       system-prompt.md and optionally advisor.mjs,
                       validates, git-commits) ──> next session
```

## Setup

1. Build the engine and install the native `neohack-mcp` executable at
   `~/.local/bin/neohack-mcp`. The bot starts it as:

   ```sh
   ~/.local/bin/neohack-mcp --http 18765 ENGINE DATA SESSIONS
   ```

   Override `NEONETHACK_MCP`, `NEONETHACK_MCP_HTTP_PORT`, or point
   `NEONETHACK_MCP_HTTP_URL` at an already-running server.

2. Configure the model endpoint:

   ```sh
   cp .env.example .env   # then edit .env (git-ignored)
   ```

   Defaults in the committed code point at OpenAI (`gpt-5.6-luna`); point
   `OPENAI_API_BASE`/`OPENAI_API_KEY`/`OPENAI_MODEL` at any
   OpenAI-compatible endpoint.

3. Install and run:

   ```sh
   npm install
   npm start            # start a NEW game (default)
   npm run continue     # resume the saved game (`node agent.mjs -c`)
   npm run runner       # continuously resume: session -> retro -> session ...
   ```

## Files

| Path | Purpose |
| --- | --- |
| `agent.mjs` | AI driver: native MCP HTTP client, advisor augmentation, continuous conversation |
| `advisor.mjs` | Standalone heuristic decision tree (run: `node advisor.mjs state/last-obs.json`) |
| `retro.mjs` | Post-session LLM self-review; improves doctrine + advisor, commits |
| `system-prompt.md` | Committed default doctrine (seed for the state dir) |
| `state/` | Default state dir: iterated `system-prompt.md` + `advisor.mjs`, conversation, observations, logs (git-ignored) |
| `sessions/` | Engine session journals (git-ignored) |
| `logs/` | Agent/runner logs (git-ignored) |
| `.env` | Local LLM endpoint config (git-ignored; see `.env.example`) |

## Notes

- The agent manages a local HTTP MCP child by default and shuts it down at the
  end of each run. Setting `NEONETHACK_MCP_HTTP_URL` uses an externally managed
  HTTP target instead.
- A normal `node agent.mjs` invocation starts a new game. Pass `-c` or
  `--continue` to resume the session tracked by `state/game-state.json`.
- Per-model-turn input/output/cache token counts are appended to
  `state/logs/token-usage.jsonl`; `state/last-run.json` contains cumulative
  output-token and cache-miss totals.
- Observation snapshots and deltas are merged into `state/last-obs.json`, so
  the advisor retains its world cache while the model receives compact deltas.
- Stuck detection tracks revealed cells, depth, position history and turns—not
  merely whether turns advance. Three zero-turn actions, short position cycles,
  or 25 turns without discovery when no downstairs is known end the run for
  retrospective repair.
- Death detection resets the conversation; the model then starts a new game
  itself (new session ids are captured automatically).
- The state directory (default `./state`, override with `NEONETHACK_BOT_STATE`)
  holds everything the bot iterates on: the LLM retro improves
  `state/system-prompt.md` and `state/advisor.mjs` after every session. Point
  `NEONETHACK_BOT_STATE` at another directory to run a separate evolving
  instance (or to keep the evolving mind out of the repository).
