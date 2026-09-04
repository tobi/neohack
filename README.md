# neonethack

NetHack as a semantic engine API, with a Lit / Three.js explorer for interactive
play and read-only review of recorded runs.

- **One C core** handles named actions, item selection, targeting, confirmations,
  observations, safe retries, and deterministic re-entry.
- **3D web components** render perceived terrain, characters, pets, objects,
  doors and stairs, with orbit/follow/cutaway controls and a 2D fallback.
- **Public perception recordings** support seeking, playback and export without
  starting an engine or replaying game commands.
- **CLI, MCP stdio and HTTP bindings** use the same core.

This is an active development project. The working baseline is tested; the full
[API design](API_DESING.md) is not yet implemented. In particular, conversion of
legacy input-only runs, several game scenarios, and further hardening remain.
See [PROJECT_PLAN.md](PROJECT_PLAN.md).

## Quick start (Linux)

Requirements: Bun (tested with 1.3.14), a C compiler, make, ncurses and UUID
development libraries, and Lua 5.4.9 development files.

On Debian/Ubuntu, the native prerequisites include `build-essential`,
`libncurses-dev`, and `uuid-dev`. Install Bun separately, then either install Lua
with mise or set `LUA_HOME` to a compatible installation:

```sh
mise install lua@5.4.9
bun install --frozen-lockfile
bun run build
bun run dev
```

Open **http://127.0.0.1:3000/play**.

The first native build bootstraps the vendored NetHack makefiles and playground
data. Subsequent builds are incremental. Builds refuse to reinstall over a
nonempty playground that lacks its data archive. Existing sessions and their
pinned engines are not replaced by a build.

Optional upstream submodules and the Emscripten SDK are not required for this
native/server-backed viewer. The retained WASM sources are a legacy path, not
the active application.

## Checks

```sh
bun test mcp/tests
bun mcp/accept.ts
bun mcp/smoke.ts
```

The regression suite currently contains 24 tests. The broader acceptance runner
reports unfinished scenarios as **skipped**, not as passing placeholders.

For browser checks, start an isolated front and Chromium with CDP enabled:

```sh
PORT=3311 SESSIONS_DIR=/tmp/neonethack-tests bun run dev
# In another terminal, with Chromium listening on CDP port 9333:
APP_URL=http://127.0.0.1:3311 bun run test:browser
```

## Project map

| Path | Purpose |
|---|---|
| `lib/` | Semantic C explorer core and process/session library |
| `upstream/` | Vendored NetHack source plus the headless port |
| `cli/` | JSON-lines bridge |
| `mcp/` | MCP transports, archive endpoints, contract tests |
| `client/` | Lit shell, reusable 3D component, pure replay client |
| `bun_server/` | Local static/API front |
| `tools/` | Builds, browser checks, maintenance helpers |

Detailed runbook: [GOAL.md](GOAL.md). Viewer documentation:
[client/README.md](client/README.md). Agent guidance:
[AGETNS.md](AGETNS.md).

## Storage and deployment

`SESSIONS_DIR` chooses persistent run storage; the default is `sessions/`.
Run state, dependencies, SDKs and generated binaries/bundles are excluded from
Git. Keep backups of your session directory separately.

The service defaults to **loopback-only** and is intended for a trusted local
environment. Origin checks and run ownership locks are not multi-user
authentication. Do not expose it as an unauthenticated public game service.

NetHack attribution and dependency notices are in [NOTICE.md](NOTICE.md).
