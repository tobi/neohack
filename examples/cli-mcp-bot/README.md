# cli-mcp-bot — an LLM plays NetHack through the neonethack MCP stdio server

An autonomous bot that plays NetHack using the neonethack C engine directly:
a Vercel AI SDK agent drives the engine through the neonethack **MCP stdio
server** (`lib/neonethack/dist/mcp/cli.js`) — no browser involved. Ops are
native-speed (~0.02s).

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

1. Build the library (engine + native bridge + MCP dist) from the repository
   root — see `lib/neonethack/docs/QUICKSTART.md`:

   ```sh
   npm ci --prefix lib/neonethack
   make -C lib/neonethack native
   npm run --prefix lib/neonethack build
   ```

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
   npm start            # one session (STEP_BUDGET model steps, default 1000)
   npm run runner       # continuous: session -> retro -> session ...
   ```

## Files

| Path | Purpose |
| --- | --- |
| `agent.mjs` | AI driver: MCP client, advisor augmentation, continuous conversation |
| `advisor.mjs` | Standalone heuristic decision tree (run: `node advisor.mjs state/last-obs.json`) |
| `retro.mjs` | Post-session LLM self-review; improves doctrine + advisor, commits |
| `system-prompt.md` | Committed default doctrine (seed for the state dir) |
| `state/` | Default state dir: iterated `system-prompt.md` + `advisor.mjs`, conversation, observations, logs (git-ignored) |
| `sessions/` | Engine session journals (git-ignored) |
| `logs/` | Agent/runner logs (git-ignored) |
| `.env` | Local LLM endpoint config (git-ignored; see `.env.example`) |

## Notes

- Sessions persist in `sessions/` and are resumable: `state/game-state.json`
  tracks the active `sessionId` across restarts. Delete it to start a fresh
  adventure.
- Death detection resets the conversation; the model then starts a new game
  itself (new session ids are captured automatically).
- The state directory (default `./state`, override with `NEONETHACK_BOT_STATE`)
  holds everything the bot iterates on: the LLM retro improves
  `state/system-prompt.md` and `state/advisor.mjs` after every session. Point
  `NEONETHACK_BOT_STATE` at another directory to run a separate evolving
  instance (or to keep the evolving mind out of the repository).
