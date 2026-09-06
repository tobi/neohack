# First five minutes

This is an unpublished alpha, not an approved registry release. Use a source
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

## Native stdio MCP (no Node runtime)

`make -C lib/neonethack native` also compiles `build/native/neonethack-mcp`, linked
against the public C library. CMake install includes the executable and its runtime
library path. Configure an MCP client with absolute paths:

```json
{
  "mcpServers": {
    "neonethack": {
      "command": "/checkout/lib/neonethack/build/native/neonethack-mcp",
      "args": [
        "/checkout/lib/neonethack/engine/playground/nethack",
        "/checkout/lib/neonethack/engine/playground",
        "/private/new-neonethack-sessions"
      ]
    }
  }
}
```

The native executable implements stdio MCP and `--http PORT` for MCP 2026-07-28
Streamable HTTP. It uses a libevent event loop and one C worker/engine per game;
calls serialize within each game and run concurrently across games. Each create
has its own persistent `SESSIONS/<sessionId>/` directory. Tool schemas are unchanged.
MCP notifications never execute game inputs, and transport cancellation cannot
undo submitted input. See [MCP usage](TYPESCRIPT.md#native-mcp) for HTTP headers,
process lifecycle and uncertainty handling. Stdio returns compact observation
updates; HTTP uses independent snapshots. No Node server adapter is required or
provided.

### Single-file Linux MCP

With Podman installed, `make -C lib/neonethack bundle` builds
`lib/neonethack/build/bundle/neohack-mcp` in an isolated Alpine/musl container.
The executable embeds the engine, Lua, game data and dependency notices; both
MCP and engine link statically. Copy that one file to `~/.local/bin/neohack-mcp`.
No Node, shared libraries, separate engine installation or external unpacker is
needed at runtime. Build tools and downloaded dependencies stay in the builder.

```sh
neohack-mcp                        # stdio, default persistent session store
neohack-mcp --http 8080            # HTTP at 127.0.0.1:8080/mcp
neohack-mcp /private/game-sessions # explicit session root
```

The default store is `$XDG_STATE_HOME/neohack/sessions`, or
`~/.local/state/neohack/sessions`. Each game owns a dedicated subdirectory.
On first launch, the executable atomically extracts its embedded runtime under
`$XDG_CACHE_HOME/neohack/runtimes/<content-hash>`, or
`~/.cache/neohack/runtimes/<content-hash>`. XDG paths must be absolute. Concurrent
launches share this immutable runtime cache; sessions retain their own engine
and data pins. Later launches verify cached bytes and reject corruption without
repairing it. New binaries select their bundled runtime for new games; resuming
an existing game continues to use its recorded pins. Cache ancestors must not be
symlinks, and the runtime cache must be owned by the user and private.

The three-path form `neohack-mcp ENGINE DATA SESSIONS` remains available for
explicit custom runtimes. All forms expose the same tools and schemas.
Run the release checks with `node --test lib/neonethack/tests/mcp-bundle.check.mjs`
after building the bundle and the TypeScript test dependencies.
