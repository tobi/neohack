# neonethack

**NetHack, without the terminal.** A perception-limited world API in C, with
TypeScript, MCP and WebAssembly bindings.

This is a fresh library-first start. The library lives in
[`lib/neonethack/`](lib/neonethack/); the small examples consume only its public
API. The former Bun server, UI and compatibility scaffolding have been removed.

```ts
const game = await nethack.create({ name: 'Ada', seed: 42 });
const result = await game.move('south');
console.log(result.outcome, result.observation);

// Choices are continuations, not overloaded actions.
if (result.decision?.kind === 'confirmation') {
  await game.answer(result.decision.id, { kind: 'confirmation', confirm: false });
}
```

No keys, inventory letters, modal terminal prompts or hidden-state queries.
Named operations have individual schemas. Every accepted operation returns the
full perceived world; genuine decisions remain the caller's responsibility.

## Build

```sh
make -C lib/neonethack
make -C lib/neonethack test
npm ci --prefix lib/neonethack
npm test --prefix lib/neonethack
```

See the [library README](lib/neonethack/README.md) for native prerequisites,
CMake/Ninja recipes and the public APIs.

## Layout

- `lib/neonethack/` — C core and engine, protocol, TypeScript, MCP, builds, docs.
- `examples/wasm/` — small browser client (`index.html`, `neonethack.ts`).
- `examples/c/` — client of the installed public C header and library.
- [`example/pixel-bun/`](example/pixel-bun/README.md) — an approachable pixel-art
  browser client, served by Bun and powered by the public WASM API. Its
  [visual design](example/pixel-bun/DESIGN.md) covers raised walls, seeded variety,
  accessible controls and the boundary between decoration and game knowledge.

**Release preparation is in progress.** Native and shared-core WASM integration
is tested, including real browser play, IndexedDB resume, native leases and
strict schema/MCP/framing checks. Source-only native/WASM builds and installed
C clients also pass. Release/source packaging and final artifact audits remain. Existing local game histories are not migrated, deleted
or published. See [distribution and release gates](lib/neonethack/docs/DISTRIBUTION.md).

NetHack retains its [original license](lib/neonethack/engine/dat/license).
A license for the new standalone project code must be chosen before publication;
see [notices](lib/neonethack/NOTICE.md).
