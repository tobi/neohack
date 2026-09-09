# neohack

**Play live at [neohack.dev](https://neohack.dev)**

**NetHack, without the terminal.** A perception-limited world API in C, with
TypeScript, MCP and WebAssembly bindings.

The library lives in [`lib/neonethack/`](lib/neonethack/); the native/browser examples and
web UI consume its public API. This is an alpha; build from source
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
Named operations have individual schemas. Library gameplay calls return full perceived snapshots; MCP/WebMCP turns use
compact observation updates, with full observations available on request. Genuine
decisions remain the caller's responsibility.

Try the [live game](https://neohack.dev), [play with an agent](lib/neonethack/docs/AGENT_BROWSER.md),
or build your own interface, learning environment, or model evaluation on the same
JSON protocol. NetHack’s C engine handles the world; your application chooses how
to experience it.

See the [changelog](CHANGELOG.md) for recent improvements to the playing experience.

## Build

```sh
make -C lib/neonethack
make mcp                     # C MCP server to ~/.local/bin/neohack-mcp
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
- [`web/neohack.dev/`](web/neohack.dev/README.md) — an approachable pixel-art
  browser client, deployed on Vercel with a static-only local Bun server and
  powered by the public WASM API. Its
  [visual design](web/neohack.dev/DESIGN.md) covers raised walls, seeded variety,
  accessible controls and the boundary between decoration and game knowledge.

- `examples/workshop/` — runs the same JavaScript example projects used by `/bots`
  against the native engine in Node.
- [`examples/chronicle/`](examples/chronicle/README.md) — condenses a static replay
  into witnessed incidents and a one-page comic epic using Muse Spark 1.3.
- `hosting/vercel/` — static delivery, private journals/accounts, public ledger
  and immutable input recordings; no server-side gameplay simulation.

Use `neonethack/low` for the complete named protocol API and `neonethack/high`
for the Hero/script API. The Node default `Nethack` constructor supplies native
engine defaults. See [API surfaces](lib/neonethack/docs/TYPESCRIPT.md).

## Play with an agent

The [live game at neohack.dev](https://neohack.dev) exposes game tools through browser-native WebMCP. Follow the
[agent-browser walkthrough](lib/neonethack/docs/AGENT_BROWSER.md) to create a game,
play from perceived observations and resume saved adventures.

## Distributions and notices

Build matching source/native/npm archives with the
[checked preview workflow](lib/neonethack/docs/DISTRIBUTION.md).
See [project and dependency notices](lib/neonethack/NOTICE.md) and the pixel
client's [art attribution](web/neohack.dev/art/ATTRIBUTION.md).

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md) for architecture boundaries and the full
validation sequence. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).
