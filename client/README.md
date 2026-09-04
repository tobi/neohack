# NetHack Explorer — Lit + Three.js

The active browser entrypoint is `index.html` → `dist/explorer-app.js`.
It renders the semantic C explorer API. It does not implement NetHack input
choreography or infer game rules from messages.

## Run

From the project root:

```sh
bun install
bun run build                # native engine, C bridge, local browser bundle
bun run dev                  # http://127.0.0.1:3000/play
```

The Lua installation path can be overridden with `LUA_HOME`. The server uses
`PORT`, `HOST` (default `127.0.0.1`), and `SESSIONS_DIR`. Run from any working
directory; static paths are resolved relative to the source tree.

For an isolated test server:

```sh
PORT=3311 SESSIONS_DIR=/tmp/nh-viewer-test bun bun_server/src/index.ts
APP_URL=http://127.0.0.1:3311 bun run test:browser
```

The browser test uses an existing Chromium CDP endpoint at
`http://127.0.0.1:9333` (override `CDP_URL`). It creates its own tab. It exercises
real game actions and saves screenshots under `/tmp/ascent/takeover/browser`.

## Components and modules

- `explorer-app.js`: `<explorer-view>` — live/replay shell, actions, typed
  decisions, inventory, status, journal, run library, timeline.
- `nh-map3d.js`: `<nh-map3d>` — presentation-only 3D map; receives an
  `observation` object and emits `tile-select`. No engine dependency.
- `world.js`: transport-only client for the MCP HTTP endpoint.
- `recording.js`: versioned checkpoint validation and pure replay; remote
  recordings use only read-only `/runs` endpoints, never `/mcp`.
- `explorer-theme.js`: shared Lit shell styling.
- `tests/browser.ts`: live-play and zero-engine-call replay browser test.

The old `map3d.js`, `sprites.js`, `input.js`, `menus.js`, and `hud.js` are retained
as legacy source, not imported by the active client. WASM artifacts are also
legacy; the current interactive page uses the server-side world API.

## 3D map

The renderer models only perceived cells: stone floor slabs, cutaway walls,
door frames/leaves, stairs, fountains, altars, objects, and stylized actors.
The explorer and allies have distinct markers. Monster appearance is an
illustration of the reported mark/color, not undisclosed monster knowledge.

- Drag to orbit; right-drag to pan; scroll/pinch to zoom.
- Fit frames the known map; Follow tracks the explorer; rotate turns the camera.
- Cutaway reduces wall height. 2D is an accessible fallback and is used if
  WebGL initialization fails or the context is lost.
- Clicking a tile inspects its returned perception; it does not auto-walk.
- Arrow keys / `hjklyubn` move by dungeon compass direction; `.` waits;
  `<` / `>` climb. Movement shortcuts are disabled in inputs and during decisions.

Live observations are authoritative after every action. No per-move
`get_state` request is needed. One game request is in flight at a time.
Semantic errors and unanswered decisions remain visible; the UI never guesses
an answer to recover from an unknown interaction.

## Review recordings

New runs record public perception frames automatically in their session folder:

- `perceptions.jsonl`: version 1 full checkpoints plus ordered public events;
- `perceptions.index.jsonl`: byte offsets, turn, revision, and sequence;
- `run.json`: small run-library summary.

Select a run to review it. Seek, step, play/pause, change speed, or export its
recording. The remote viewer pages recordings and caps its cache rather than
loading an entire long run into memory. An imported `.jsonl` recording works
without a live engine; imports are currently limited to 128 MB.

Replay is read-only, including at recorded confirmations. Returning to Live
restores the live observation; it does not rewind the engine. Seeking backwards
replaces the full perceived map, so future terrain is not retained.

Legacy `input.log.jsonl` files are **not** public perception recordings. They are
listed as requiring explicit conversion, not silently replayed by the viewer.
Existing run files are preserved. The core pins each run's engine executable
before recreating its playground on resume.

## Current limitations

This is the first integrated 3D implementation, not a claim of full design
completion. See `PROJECT_PLAN.md` and `API_DESING.md` for remaining work:
legacy-run conversion, stronger scenario coverage, unsupported game actions,
crash-boundary recording recovery, and richer semantic engine context. There
is no multi-user authentication: the default service is loopback-only and is
intended for a trusted local environment.
