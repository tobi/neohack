# NetHack Explorer — runbook

A semantic NetHack engine API with a Lit/Three.js viewer for interactive play
and read-only review of recorded expeditions. The target contract is
[API_DESING.md](API_DESING.md); current work and remaining gaps are tracked in
[PROJECT_PLAN.md](PROJECT_PLAN.md).

## Current verified milestone (2026-09-04)

- The active `/play` page is the new **Lit + Three.js** application, not the
  retired flat `awaiting` client. Models, cutaway walls, stairs, objects, camera
  controls, inventory, named actions, typed decisions, and a journal work.
- Browser checks pass for starting, moving, eating a selected ration, declining
  prayer, directional kick, save/resume, mobile layout, and replay seeking.
- Replay produced **zero engine calls** in the browser test. It reads indexed
  public perception checkpoints/events, not NetHack input logs.
- The core's food listing is non-mutating, uses perceived item classes, and no
  longer offers spears as pears. Missing targets produce real target decisions.
- Retry fingerprints include item/target/decision payloads. Open doors retain
  their semantic terrain type. Known ground survives under the explorer.
- Pending item and target decisions survive deterministic resume. Current
  belongings and conditions arrive from the engine without inventory-key peeks.
- Runs pin their engine executable. New worlds cannot truncate an existing
  session merely by reusing its id. New runs record versioned public perceptions.
- An exclusive per-run lease prevents competing bridges from driving or
  rebuilding the same live world. Ownership handoff reloads current metadata.
  The run's engine retains that lease while exiting, so killing its bridge
  cannot let another process replace a playground that is still being saved.
- Cold-restart tests cover pending food/target decisions and confirmation
  receipts. Request ids are reserved durably before execution; older receipts
  are recovered from the archive rather than forgotten after 64 cached replies.
  A missing receipt or torn request journal fails closed instead of repeating
  an uncertain action.
- The native C acceptance program and MCP smoke pass. `bun test mcp/tests`
  covers actual engine regressions and read-only recording/replay behavior.
- The older broad acceptance runner reports **10 pass / 5 skip**, not 15 fake
  passes. The remaining scenarios must still be staged and tested.

This is a working integrated milestone, **not a claim that every design goal
or every NetHack action is implemented**. In particular, no ascent has been
achieved by the bot experiments.

## Run

Requirements: Bun, a C compiler/make, the existing NetHack playground data, and
Lua 5.4 development files. The default Lua path is the existing mise 5.4.9
installation; override with `LUA_HOME` if needed.

```sh
bun install
bun run build          # incremental engine + C bridge + browser bundle
bun run dev            # http://127.0.0.1:3000/play
```

The browser bundle is self-hosted. There are no runtime CDN dependencies.

Configuration:

- `PORT` / `HOST`: front-end server (defaults 3000 / 127.0.0.1).
- `SESSIONS_DIR`: persistent run storage (default repository `sessions/`).
- `ENGINE_CMD`, `PLAYGROUND_TEMPLATE`, `NHXCLI`: explicit engine/data/bridge paths.
- `MCP_ALLOWED_ORIGINS`: optional comma-separated allowed web origins. Same-origin
  requests work by default. Origin checks are not user authentication.

Development servers should run in dedicated Herdr panes. Use isolated sessions
for tests, not a player's live world:

```sh
PORT=3311 SESSIONS_DIR=/tmp/nh-viewer-test bun bun_server/src/index.ts
```

The old static WASM server at 8901 is not the current interactive application.
The new page needs the world API provided by the Bun front.

## Checks

```sh
bun test mcp/tests
bun mcp/accept.ts
bun mcp/smoke.ts
cc -Wall -Wextra -Ilib -o /tmp/test_explorer lib/test_explorer.c \
  lib/explorer.c lib/session.c lib/minjson.c && /tmp/test_explorer
APP_URL=http://127.0.0.1:3311 bun run test:browser
```

The browser test connects to Chromium CDP at `127.0.0.1:9333` (`CDP_URL` override),
creates its own tab, and writes evidence under `/tmp/ascent/takeover/browser`.
It does not touch other browser tabs. Use `EVIDENCE_DIR` to choose another output.

The engine conformance vectors and WASM build predate the new perception
notifications; they need an explicit compatibility pass before being described
as current. Do not automatically regenerate golden vectors to hide regressions.

## Architecture

- `upstream/win/headless/`: existing engine port. Now emits read-only perceived
  inventory/floor objects, object classes/identities, location, and perceived
  terrain symbols at input boundaries. It does not expose unseen map contents.
- `lib/explorer.c`, `lib/session.c`, `lib/minjson.c`: semantic action driver,
  decisions, observations, request/revision handling, engine pinning, input-log
  resume, and public-perception recording. Core game semantics live here.
- `cli/nhxcli.c`: NDJSON bridge; all bindings forward to the same core.
- `mcp/src/server.ts`, `core.ts`, `http.ts`: MCP proxy, bridge ownership, and
  Streamable HTTP. `mcp/src/adapter.ts` is retired and must not be extended.
- `mcp/src/runs.ts`: read-only archive listing and indexed frame access; no core
  or engine import.
- `client/explorer-app.js`: Lit live/replay shell.
- `client/nh-map3d.js`: reusable presentation-only 3D web component.
- `client/recording.js`: version validation, pure checkpoint replay, paged cache.
- `client/world.js`: transport-only browser binding.
- `bun_server/src/index.ts`: static client/site, `/mcp`, `/runs`, `/api-docs`.
- `tools/build-*.ts`, `tools/cdp.ts`: reproducible builds and browser test support.

See [client/README.md](client/README.md) and [client/API.md](client/API.md).

## Recording and preservation

A run folder contains its original `input.log.jsonl` and semantic sidecar plus:

- `.lease`: kernel-managed exclusive ownership while a bridge owns the world;
- `requests.seen.jsonl`: durable request-id reservations (private, not exported);
- `engine`: a pinned executable, hard-linked from the local `.engines/` cache;
- `perceptions.jsonl`: versioned public response checkpoints plus ordered events;
- `perceptions.index.jsonl`: sequence/turn/revision/byte-offset index;
- `run.json`: run-library summary.

Normal exact request retries and observational reads do not append duplicate
perception frames. Playback/seek does not launch an engine. Full checkpoints
prevent future map state from leaking backwards in a replay.

Legacy input-only runs are listed honestly as requiring conversion. No existing
logs are overwritten, and conversion must be explicit and isolated. When an old
session has no engine pin, resume preserves its existing playground executable
before recreating the playground.

## Remaining work / caveats

- Explicit legacy input-log conversion into public perception recordings.
- Real locked-door, multi-level descent, pet exchange, terminal/death, and
  bounded-interruption scenarios (the old suite's remaining skips).
- Complete strict argument validation, richer semantic engine prompt context,
  more supported actions (`cast`, `engrave`, and others remain unbound).
- Crash-boundary recovery/repair for partially written recording indexes and
  semantic metadata. Missing receipts fail closed; this is not a claim that
  arbitrary power-loss damage can already be repaired automatically.
- Broader item identity/eligibility edge cases and floor selection scenarios.
- WebGL loss/recovery, larger-map rendering/performance, more accessibility and
  keyboard/targeting UX refinements, and browser reload/connection recovery.
- Legacy engine/WASM compatibility and regenerated *reviewed* conformance tests.
- Multi-user authentication/authorization. The service is presently for a
  trusted local environment; do not expose it as a public multiplayer service.

Before restarting a running front, `bun tools/drain-server.ts http://127.0.0.1:3000`
shows worlds loaded by that server. Add `--apply` to save/leave those worlds
without resuming archived sessions. Then restart the owned service. Upgrade all
bridges sharing a session root before relying on leases: old binaries do not
participate in the ownership protocol.

The engine's upstream tree already contains other uncommitted work. Preserve it;
project takeover is not permission to reset someone else's changes.
