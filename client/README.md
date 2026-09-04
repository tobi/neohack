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
`http://127.0.0.1:9333` (override `CDP_URL`). It creates and closes its own tab (`KEEP_BROWSER_TAB=1` preserves it for debugging). It exercises
real game actions and saves screenshots under `/tmp/ascent/takeover/browser`.

## Components and modules

- `explorer-app.js`: `<explorer-view>` — live/replay shell, actions, typed
  decisions, inventory, status, journal, run library, timeline.
- `nh-map3d.js`: `<nh-map3d>` — stylized models; receives an observation and
  emits `tile-select`. No engine dependency.
- `map-surface.js`: WebGL lifecycle, on-demand rendering, keyboard grid/fallback.
- `map-presentation.js`: pure bounded display preparation; never game rules.
- `nh-inspection.js` / `inspection.js`: pure inspection panels/projection for
  self, here and selected squares. Unknown is not empty, and equipment flags
  come from the engine rather than name parsing.
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
- Cutaway reduces wall height. WebGL loss/failure exposes a keyboard-accessible
  2D grid. Context restoration rebuilds the latest view; Retry 3D is also available.
- Explicit 2D mode releases GPU resources and survives reconnect. Hidden and
  settled maps do not continuously draw; reduced-motion preferences are honored.
- Clicking a tile inspects its returned perception; it does not auto-walk.
- **Map focus:** arrows inspect tiles, Enter selects, Escape leaves map focus.
  The 2D grid supports Home/End and Page Up/Down across large maps.
- **Game keyboard zone:** arrows / `hjklyubn` move, `.` waits, `<` / `>` climb.
  Map inspection, form inputs and content-editable areas never issue game keys.
  Escape cancels a cancellable decision even when its button/input is focused.

Live observations are authoritative after every action. No per-move
`get_state` request is needed. One game request is in flight at a time.
Semantic errors and unanswered decisions remain visible; the UI never guesses
an answer to recover from an unknown interaction.

## Standalone component and renderer checks

```sh
bun run build:component
# Serve client/dist/standalone/ over HTTP; open demo.html.
bun run test:component       # own sandboxed headless Chrome + static-only fixture
# Existing CDP + isolated live candidate, including keyboard/game isolation:
APP_URL=http://127.0.0.1:3312 bun run test:browser:renderer
```

The bundle is a single ESM file with no application/engine dependency. A demo,
README, optional source map and dependency licenses accompany it; private CI
uploads the verified folder as `nh-map3d`. Source properties/methods and bounds
are documented in [API.md](API.md). `worldKey` scopes level IDs between worlds.

Renderer tests use explicitly illustrative presentation fixtures, not fabricated
claims about game physics. They exercise actual WebGL context loss/restoration,
partial construction and draw failures, reconnect, GPU release, reduced motion,
idle/hidden behavior, bounded 2D navigation and 20,000-cell fitting. The live
integration separately verifies one real move and typed Escape cancellation.
This is not a complete screen-reader/browser compatibility audit.

## Inspect without guessing

Inspect Self shows reported vitals, conditions, equipment assignments and
belongings. Inspect Here shows the explorer's current square and captured floor
items. A selected remote square shows only map sightings. These panels follow
the current observation rather than retaining old cell objects.

When live and ready, an inspection is a named zero-turn core action. At a
standing decision or while replaying, it reads returned data without submitting
an action/answer. Replay inspection pauses playback; stale seeks/imports cannot
replace the inspected frame or a returned live view. Keyboard focus and mobile
scrolling make the panel reachable; Escape closes it without cancelling a
waiting game decision. `test:browser:inspection` covers these flows.

`perception` freshness and item `usage` are new engine facts. Older engine pins
and recordings keep their original data and are labeled last-known/unspecified
where appropriate; labels are never upgraded into inferred equipment facts.

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

Legacy `input.log.jsonl` files are **not** public perception recordings. Their
library entries offer explicit sandboxed reconstruction with a confirmation.
The resulting archive is labeled **unverified** and cannot become a live game.
Original files are preserved. See [reconstruction details](../docs/RECONSTRUCTION.md).
Normal playback still never starts an engine. The core pins each live run's
engine executable before recreating its playground on resume.

Damaged checkpoints can be preserved with the explicit operator command
`bun tools/salvage-run.ts SESSIONS_DIR RUN_ID NEW_BUNDLE_DIR --confirm`.
It copies all evidence without running an engine and exports a warning-labeled
read-only prefix. Import that review file here (up to 128 MiB). It does not
repair a live session; see [recovery limits](../docs/RECORDING_RECOVERY.md).

## Current limitations

This is a tested renderer milestone, not a claim of full design completion. See `PROJECT_PLAN.md` and `API_DESING.md` for remaining work:
historical-verification limits, stronger scenario coverage, unsupported game actions,
live continuation after damage, private-journal recovery, and richer semantic engine context. There
is no multi-user authentication: the default service is loopback-only and is
intended for a trusted local environment.
