# neonethack

**NetHack, without the terminal.** A perception-limited world API in C, with
TypeScript, MCP and WebAssembly bindings.

The library lives in [`lib/neonethack/`](lib/neonethack/); native, browser and
pixel-art examples consume its public API. This is an alpha; build from source
using the guides below.

```ts
import Nethack from 'neonethack';

const nethack = new Nethack();
const game = await nethack.create({ name: 'Ada', seed: 42 });
const result = await game.move('south');
console.log(result.outcome, result.observation);

// Choices are continuations, not overloaded actions.
if (result.decision?.kind === 'confirmation') {
  await game.answer(result.decision.id, { kind: 'confirmation', confirm: false });
}
await nethack.close();
```

No keys, inventory letters, modal terminal prompts or hidden-state queries.
Named operations have individual schemas. Every accepted operation returns the
full perceived world; genuine decisions remain the caller's responsibility.

Try the [live game](https://neohack.dev), [play with an agent](lib/neonethack/docs/AGENT_BROWSER.md),
or build your own interface, learning environment, or model evaluation on the same
JSON protocol. NetHack’s C engine handles the world; your application chooses how
to experience it.

## Build

```sh
make -C lib/neonethack
make -C lib/neonethack test
npm ci --ignore-scripts --registry=https://registry.npmjs.org --prefix lib/neonethack
npm test --prefix lib/neonethack
```

Start with the [quickstart](lib/neonethack/docs/QUICKSTART.md) for a runnable
example. See the [library README](lib/neonethack/README.md) for native
prerequisites, CMake/Ninja recipes and the public APIs.

## Layout

- `lib/neonethack/` — C core and engine, protocol, TypeScript, MCP, builds, docs.
- `examples/wasm/` — small browser client (`index.html`, `neonethack.ts`).
- `examples/c/` — client of the installed public C header and library.
- [`example/pixel-bun/`](example/pixel-bun/README.md) — an approachable pixel-art
  browser client, served by Bun and powered by the public WASM API. Its
  [visual design](example/pixel-bun/DESIGN.md) covers raised walls, seeded variety,
  accessible controls and the boundary between decoration and game knowledge.

## Play with an agent

The [live game at neohack.dev](https://neohack.dev) exposes game tools through browser-native WebMCP. Follow the
[agent-browser walkthrough](lib/neonethack/docs/AGENT_BROWSER.md) to create a game,
play from perceived observations and resume saved adventures.

## Distributions and notices

Build matching source/native/npm archives with the
[checked preview workflow](lib/neonethack/docs/DISTRIBUTION.md).
See [project and dependency notices](lib/neonethack/NOTICE.md) and the pixel
client's [art attribution](example/pixel-bun/art/ATTRIBUTION.md).

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md) for architecture boundaries and the full
validation sequence. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).
