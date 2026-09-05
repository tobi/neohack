# WebAssembly

WASM runs **the same C semantic core** as native. A private worker owns the core
and journal store; each engine runs in a separate private worker. TypeScript
transports messages and renders observations—it does not resolve items, translate
NetHack commands, answer prompts, reconstruct decisions or implement game rules.

## Build and run the example

Requirements: native engine build prerequisites, Node ≥22.18, CMake, Make/Ninja,
and Emscripten (tested with **6.0.9**). No browser `SharedArrayBuffer`, COOP/COEP
headers or Bun runtime is required.

```sh
# Activate your Emscripten SDK first, or set EMSDK=/path/to/emsdk.
make -C lib/neonethack wasm
npm ci --prefix lib/neonethack
npm run --prefix lib/neonethack build:example
npm run --prefix lib/neonethack serve:example
# Open http://127.0.0.1:8080/examples/wasm/index.html
```

The build first prepares host-generated headers/data, then cross-compiles the
engine and semantic core. CMake/Ninja tracks sources, included headers, compile
flags and preloaded data; no stale-object "exists, therefore skip" rules.
Lua 5.4.9 source is fetched from lua.org with a pinned SHA-256. Its code and the
engine are compiled separately from native libraries.

Artifacts go to `dist/wasm/`: two WASM modules, ESM loaders, private workers,
static game data, licenses and a content-derived build manifest. Relocate that
whole directory together. The npm package also includes the high-level client
under `dist/typescript/` and exports `neonethack/wasm`.

```ts
import { createWasm } from 'neonethack/wasm';

const nethack = await createWasm({
  storage: { kind: 'indexeddb', name: 'my-worlds' },
});
try {
  const game = await nethack.create({ name: 'Ada', seed: 42 });
  const result = await game.move('south');
  console.log(result.observation);
  await game.close();
} finally {
  await nethack.close();
}
```

The example at `examples/wasm/index.html` / `neonethack.ts` uses only this API.
Its server serves static files only: no gameplay HTTP requests, uploads, sessions,
or engine process. The example renders public layered perception as a small
text map; it does not consume raw terminal data.

## Explicit storage modes

### `memory` (default)

Works in browsers and Node. Each runtime has an isolated in-memory store.
`game.close()` followed by `nethack.resume(id)` works **within that runtime**,
including pending decisions and exact retry receipts. Closing the transport,
reloading the page or terminating the worker loses this store. It is not a save
to disk. Discovery reports `durability:"none"`.

### `indexeddb`

Requires IndexedDB, Web Locks and gzip Compression/Decompression Streams in a
secure browser context (HTTPS or localhost).
The store name is 1–64 ASCII letters, digits, hyphens or underscores. Each name
has a distinct origin-local database and an exclusive Web Lock held for the
runtime's lifetime. A competing worker/tab is refused; it does not take over or
silently fall back to memory. Explicitly close the transport to release ownership.

Each native C `fsync` boundary awaits committed IndexedDB storage, including the
**pre-input** journal/reservation boundaries. Persistence is not deferred to an
unload handler or to the end of the action. Files use content-addressed 64 KiB
blocks, gzip-compressed when smaller. Appends process only changed blocks;
unchanged history is neither rewritten nor recompressed. A strict-durability
transaction atomically commits file manifests, new blocks and removal of blocks
that no file references. An unchanged boundary needs no additional transaction.
Compression completes before the transaction opens, and acknowledgement waits
for transaction completion. A failed transaction poisons the owner until reload.

Block hashes, sizes, gzip trailers, manifest structure and references are checked
on load; damaged stores are rejected without repair or truncation. Millisecond
timestamps remain monotonic for the C integrity checks. Receipt compaction removes
only duplicate sidecar responses whose exact bytes have reached the authoritative
perception journal. Reservations and complete historical receipts remain intact,
including receipts older than the in-memory cache.

The block format uses the database `/neonethack/<name>` (schema version 22)
and exclusive `neonethack:v1:<name>` Web Lock. A schema upgrade deletes old
stores and creates empty current-format stores. Development saves are disposable;
there is no migration, legacy decoder or parallel legacy database.

Discovery reports `durability:"indexeddb-transaction"`, not native fsync or a
guarantee against browser eviction, storage clearing, device failure or every
power-loss case. Quota/transaction failures must not be "fixed" by repeating the
action with another request ID. Keep durable backups for important worlds;
export/import tooling is not yet part of the public v1 API.

## Build identity and resume

The WASM runtime pins a content-derived **package identity**, including core,
engine, data and worker code. Binary/data resources are checked against the
manifest before use. A stored game from another build is refused without
rewriting its input journal or pin. It is never silently replayed on upgraded
code. Retain the original complete WASM package if its worlds must remain
resumable; unlike native executable pins, browser storage does not archive every
old package's binaries for you.

Native and WASM use different target architectures; **identical maps across
native and WASM builds are not promised**. Matching build, data and inputs are
also insufficient without the recorded runtime profile. Profile 1 fixes the
calendar at creation in UTC and isolates user options, on both targets. See
[runtime profiles and remaining replay limits](REPLAY.md).
Observations, outcomes, decisions and retry semantics share the protocol and C
implementation.

`protocol.describe` reports the active guarantees:

| Backend/store | Persistence | Durability | Ownership | Resume |
|---|---|---|---|---|
| Native | filesystem | fsync | process-lease | pinned-executable |
| WASM memory | memory | none | isolated-worker | same-package |
| WASM IndexedDB | indexeddb | indexeddb-transaction | origin-web-lock | same-package |

## Checks

```sh
npm run --prefix lib/neonethack test:wasm
npm run --prefix lib/neonethack test:browser
```

Node tests execute the actual WASM C core and engine: create/play, choices,
cancellation, pending resume, exact receipts, independent worlds, shape rejection,
unsupported durability and damaged binary rejection. Browser checks launch a
sandboxed Chromium (set `CHROMIUM` if not installed at `/usr/bin/chromium`) and
test the actual example, pending-consent reload, owner loss without close,
exclusive ownership, old-receipt retrieval, package-pin mismatch and torn input
preservation. All game traffic remains inside the workers; HTTP only loads
static resources. This is not an exhaustive browser or power-loss audit.
