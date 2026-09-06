# libneonethack

NetHack as a library, not a terminal.

Send a named operation. Receive what happened, the explorer's full perceived
world, and—only when necessary—a genuine choice. No keystrokes, inventory
letters, display pauses, or hidden-state queries are part of the public API.

The C API, TypeScript client, MCP adapter and shared-core WASM runtime are
implemented and covered by native and browser integration tests. This is an
alpha. Checked previews include matching source/native/npm archives.
New worlds use a [recorded runtime profile](docs/REPLAY.md): a fixed UTC creation
calendar and isolated user options. Incompatible historical worlds are refused.

Start with the [first-five-minutes guide](docs/QUICKSTART.md) for runnable
source, browser and installed-preview paths.

WebMCP and stdio MCP return [compact observation deltas](docs/PROTOCOL.md#mcp-observation-presentation).
The native build includes a [C stdio MCP server](docs/QUICKSTART.md#native-stdio-mcp-no-node-runtime),
`neonethack-mcp ENGINE DATA SESSIONS`, with no JavaScript runtime requirement.

Try the [live pixel client](https://neohack.dev) or follow the
[agent-browser/WebMCP walkthrough](docs/AGENT_BROWSER.md) without a local build.
The rest of this guide covers using the library in your own application.

## Shape of the API

```ts
import Nethack from 'neonethack';

const nethack = new Nethack();
try {
  const game = await nethack.create({ name: 'Ada', role: 'valkyrie', seed: 42 });
  const step = await game.move('south');
  console.log(step.outcome, step.observation);

  const food = await game.eat(); // candidates, not an implicit selection
  if (food.decision?.kind === 'item') {
    // The caller, not the library, chooses an item or cancels.
    await game.cancel(food.decision.id);
  }
  await game.close(); // retains journals; does not quit or delete the game
} finally {
  await nethack.close();
}
```

`Nethack` is the native Node.js entry point. After building the library, its defaults
locate the CLI and engine relative to the package, and save runs under `./sessions`.
Pass `executable`, `enginePath`, `dataPath` or `sessionsPath` to use an installed
native distribution or another storage directory. Use `neonethack/wasm` in browsers.

The client serializes operations, supplies revision guards and request IDs,
and returns immutable full frames. It never confirms, retries, walks, or resumes
an interrupted activity for you. A lost response preserves the exact request and
blocks new operations until uncertainty is addressed.

## Build native

Requirements: C99 compiler, CMake ≥3.20, Make, Ninja (or CMake's Unix Makefiles
generator), `flock` (util-linux), Lua 5.4 headers/static library, ncurses and UUID
development files. The tested native build platform is Linux.
The library alone has no Lua or Node dependency; these are engine/tooling needs.

```sh
# From this directory:
make                         # C library, public CLI, stdio MCP, native engine/data
make test                    # actual C/engine integration
npm ci                       # Node ≥22.18, only for TS/MCP tooling
npm test                     # typecheck + real-engine protocol/client tests
npm run test:install          # static/shared, Debug/Release, Make/Ninja + relocation
```

Set `LUA_HOME` to a Lua 5.4 installation if pkg-config or mise cannot locate it.
The pkg-config resolver supports `include/lua5.4` and multiarch `liblua5.4.a`
layouts; `npm run test:lua-layout -- HEADER_DIRECTORY STATIC_LIBRARY` independently
builds and plays a fresh engine using that layout, without changing your Lua
installation or reusing the main engine's generated files.
Use `make GENERATOR='Unix Makefiles'` without Ninja, or drive CMake directly:

```sh
cmake -S . -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --target native
cmake --install build/native --prefix /your/prefix
```

Installation includes the C library/header, CLI, CMake/pkg-config metadata,
schemas, engine at `libexec/neonethack/engine`, static data at
`share/neonethack/data`, and NetHack/Lua notices. Pass those engine/data paths
explicitly. Use `-DNNH_INSTALL_ENGINE=OFF -DBUILD_TESTING=OFF` and build the
default target for a library-only installation without Lua/engine tooling.

New sessions copy only allowlisted static data, never saves, bones or logs.
Builds do not replace per-session executable/data pins or reinstall over a
nonempty damaged playground. Generated protocol sources are committed, so native
builds do not require JavaScript.

## Three surfaces, one contract

- **C:** [`include/neonethack.h`](include/neonethack.h). Opaque context/result
  ownership, typed operations and length-delimited JSON dispatch. Process plumbing
  and engine headers are private.
- **TypeScript:** [`typescript/client.ts`](typescript/client.ts), with a separate
  Node transport. The browser-facing client has no Node or Bun imports.
- **MCP:** one tool per method, strict input/output schemas, tool annotations,
  structured results and descriptions of costs, choices and retry behavior.

- **WASM:** [`typescript/wasm.ts`](typescript/wasm.ts) runs the same C core with
  isolated engine workers. Choose volatile memory or explicitly locked,
  transaction-backed IndexedDB storage; discovery reports the guarantees.

### Browser example

```sh
make wasm                    # requires activated Emscripten, tested 6.0.9
npm run build:example
npm run serve:example        # static-only server, no game backend
npm run test:wasm
npm run test:browser         # sandboxed Chromium
```

See [WASM build, persistence and resume](docs/WASM.md).

## Read next

- [Protocol](docs/PROTOCOL.md): lifecycle, requests, results and guarantees.
- [C API](docs/C_API.md): ownership, errors, threading and typed calls.
- [TypeScript and MCP](docs/TYPESCRIPT.md): clients, decisions and uncertainty.
- [WebAssembly](docs/WASM.md): building, browser example and storage guarantees.
- [Distributions](docs/DISTRIBUTION.md): checked native/npm/source previews,
  source provenance and embedded dependencies.
- [`protocol/catalog.json`](protocol/catalog.json): exact supported methods.
- [`protocol/request.schema.json`](protocol/request.schema.json) and
  [`protocol/response.schema.json`](protocol/response.schema.json).

Raw engine documentation under `protocol/engine/` is implementation material,
not a client interface.

## License

NetHack retains its original license in [`engine/dat/license`](engine/dat/license).
See [notices](NOTICE.md) for project and dependency licensing.

Browser agents can use the complete MCP catalog through [`neonethack/webmcp`](docs/WEBMCP.md). The adapter uses native WebMCP and the application’s public transport; the pixel client shares its persistent engine and HUD with agent calls.
