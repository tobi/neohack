# First five minutes

This is a source-build alpha; the npm package is not a published registry release. Use a source
checkout/archive or a matching local preview; do not assume `npm install
neonethack` retrieves this code. Linux is the tested native platform.

## From source: one real world

Requirements: C99 compiler, CMake, Make/Ninja, `flock`, ncurses/UUID development
files, Lua 5.4 development files (or the Lua archive included in a source preview),
and Node ≥22.18. See the library README for installation/toolchain details.
From the **repository/source root**:

```sh
make -C lib/neonethack test
npm ci --prefix lib/neonethack
npm run --prefix lib/neonethack build
cd lib/neonethack
node --input-type=module <<'JS'
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createNative } from 'neonethack/native';

const sessionsPath = await mkdtemp(`${tmpdir()}/neonethack-demo-`);
const api = createNative({
  executable: './build/native/neonethack',
  enginePath: './engine/playground/nethack',
  dataPath: './engine/playground',
  sessionsPath,
});
try {
  const game = await api.create({ name: 'Ada', seed: 42, role: 'valkyrie' });
  console.log((await game.wait()).observation);
  const offer = await game.pray();
  if (offer.decision) await game.cancel(offer.decision.id); // explicit caller choice
  await game.close(); // retire engine, retain world; not in-game quit
  console.log({ sessionId: game.id, sessionsPath });
} finally { await api.close(); }
JS
```

This creates a **new temporary directory**, not an existing player store. Retain
its printed path/ID to resume with the same runtime. Inspect `outcome`, `events`
and the full `observation`; a warning/choice is not an instruction to repeat the
initiating action. Answer or cancel the returned decision explicitly.

For the default native layout, use `import Nethack from 'neonethack'` and
`new Nethack()` as shown in the [repository introduction](../../../README.md).
The explicit `createNative` example above deliberately selects a fresh temporary
store and build paths. `neonethack/high` is the Hero/script API for an explicit
transport; `neonethack/low` exposes exact named protocol calls.

## Browser: no gameplay server

From the source root, with Emscripten 6.0.9 installed:

```sh
EMSDK=/absolute/path/to/emsdk make -C lib/neonethack wasm
npm run --prefix lib/neonethack build:example
npm run --prefix lib/neonethack serve:example
```

Open the loopback URL printed by the static server. The example runs the C core
and engine in workers, renders only perceived information and leaves choices to
the caller. It does not send gameplay HTTP requests. Memory storage is volatile;
IndexedDB requires Web Locks and exclusive ownership. Keep the original complete
WASM package for stored worlds. See [WASM.md](WASM.md).

## Installed preview

Keep matching source/native/npm archives and checksums together. Verify
`SHA256SUMS`, extract the native archive to a versioned prefix, and install the
local npm tar in a **separate consumer project** with lifecycle scripts disabled:

```sh
npm install --ignore-scripts /absolute/path/neonethack-1.0.0-alpha.1.tgz
```

Use `createNative` with the extracted `native/bin/neonethack`,
`native/libexec/neonethack/engine` and `native/share/neonethack/data` paths, or
`await createWasm()` from `neonethack/wasm`. A native preview targets its build
host/architecture, not every Linux ABI. C consumers include only `neonethack.h`
and link via `neonethack::neonethack` in CMake or `pkg-config neonethack`.
See [DISTRIBUTION.md](DISTRIBUTION.md) for the checked preview/archive audit.

## Do not miss

- Profile 1 freezes the calendar at creation in UTC and ignores user RC/options.
  A seed alone is not a complete world identity. Unprofiled old journals are
  refused, not migrated by inventing original settings. [REPLAY.md](REPLAY.md).
- A lost reply means uncertainty. Retain the exact request ID/payload; do not
  silently issue a new request. Creation itself is not retry-idempotent.
- Never delete, truncate, patch or replay damaged history with upgraded pins to
  make an error disappear. Preserve original files/runtimes for inspection.
- Serialize all C calls in a process, even across contexts. Native executables,
  data and stores are trusted resources, not an authorization/sandbox boundary.

## Bun/WASM MCP

Install Bun (tested 1.3.14), Node build tooling and Emscripten 6.0.9, then:

```sh
npm ci --prefix lib/neonethack
EMSDK=/path/to/emsdk make mcp
./bin/neohack-mcp                      # stdio
./bin/neohack-mcp --http 8080           # 127.0.0.1:8080/mcp
./bin/neohack-mcp --list                # local run tokens/pins, no gameplay
# Optional user installation:
EMSDK=/path/to/emsdk make mcp MCP_PREFIX="$HOME/.local"
```

A source build installs the launcher and a companion `libexec/neohack-mcp/`
runtime directory. No C MCP executable, libevent, separate ENGINE/DATA arguments
or native engine process is used. The precise native C library/NDJSON CLI remain.
The npm preview also exposes `node_modules/.bin/neohack-mcp` (requires Bun).

```json
{"mcpServers":{"neohack":{"command":"/checkout/bin/neohack-mcp"}}}
```

The default store is `$XDG_STATE_HOME/neohack/mcp-wasm`, falling back to
`~/.local/state/neohack/mcp-wasm`. Override with `--sessions /private/path`.
This is a new WASM store, not a migration of native C saves. Existing stores and
published browser pins are never rewritten. `--runtime` selects a complete
WASM package only for new games; resume verifies and uses the recorded package.
See [MCP](TYPESCRIPT.md#bunwasm-mcp) for concurrency and recovery.
