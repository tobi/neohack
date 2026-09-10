# neohack

The system's canonical name is **neohack**, always lowercase in branding, prose
and conversation. NetHack is the upstream game's name; retain its attribution.

NetHack's engine, exposed through a semantic protocol, with an approachable web
UX. Humans and agents play the same game through the same perceived information
and explicit decisions. Improving access to that information is the goal; the
low-level protocol must not become a hidden-state oracle or change the game's
rules. Higher-level interfaces may provide clearly labelled navigation and agent
conveniences computed from perceived knowledge, while preserving real decisions.

## Project map

The supported engine and library implementation lives in `lib/neonethack/`.
Follow a change through these layers rather than implementing a separate version
of its semantics in each client:

| Part | Responsibility |
| --- | --- |
| `lib/neonethack/engine/` | Pinned NetHack source, game rules and headless integration. Supplies what the hero actually perceives and the engine's genuine input decisions. |
| `lib/neonethack/src/` | Shared C semantic driver, public dispatch, perception, action/decision handling, sessions, journals, receipts and replay integrity. `explorer.*` and private headers are internal. |
| `lib/neonethack/protocol/`, `include/neonethack.h`, `docs/PROTOCOL.md` | Public contract. `protocol/catalog.ts` generates method schemas, C dispatch metadata, TypeScript requests and MCP definitions; `protocol/response.ts` defines response schemas. Regenerate with Node and check drift. |
| `lib/neonethack/cli/` | Native process entry point: public NDJSON requests/responses. These expose the semantic contract, not the engine's private input protocol. |
| `lib/neonethack/typescript/` | Typed library clients and native/browser transports. Client conveniences preserve protocol meaning, costs, decisions and uncertainty. |
| `lib/neonethack/wasm/` | The same C driver and engine in browser workers, with explicit storage ownership and durability guarantees. Worker plumbing does not own game rules. |
| `lib/neonethack/mcp/`, `typescript/webmcp.ts` | One shared TypeScript MCP service/agent adapter, used by browser WebMCP and the Bun stdio/HTTP CLI over the same C WASM engine. Transport code must not duplicate tool dispatch, navigation or presentation. |
| `examples/` | Small public-API consumers and runnable integration examples. Keep sample clients correct and their command-coverage limits explicit. |
| `web/neohack.dev/` | The developing web UX: character creation, dungeon map, local views, inventory, settings, accessible controls and agent interaction. Read its [AGENTS.md](web/neohack.dev/AGENTS.md) and [DESIGN.md](web/neohack.dev/DESIGN.md) before UX work. |
| `hosting/vercel/` | Website/runtime delivery, durable cloud storage and supporting web services. Browser gameplay runs in WASM; hosting does not duplicate game rules or provide a separate HTTP gameplay engine. |

The flow is **client intent → named semantic operation → C driver → NetHack →
perceived observation, actual outcome and any standing decision → client**.
The C library, typed library, NDJSON, MCP and WebMCP are surfaces of this contract,
not different games. WebMCP in the pixel client shares the active game with the
human-facing HUD. Do not restore the retired native C MCP implementation, old Bun gameplay server, old UI, generic
public `act` tool, raw-key escape hatch or JS semantic adapter.

## Documentation authority

Keep current guidance consistent across these documents:

- This file defines architecture and integrity boundaries; CONTRIBUTING.md gives
  contributor checks. README files provide entry points, not alternate contracts.
- The protocol catalog, response schemas and public C header define the API.
  PROTOCOL.md explains that contract; COMMAND_COVERAGE.md records demonstrated
  coverage and limits. A design goal is not evidence of an implemented operation.
- web/neohack.dev/AGENTS.md and DESIGN.md define the current UX and approved art.
  When behavior changes, replace superseded guidance instead of appending a
  contradictory rule. Label future proposals and historical measurements.
- hosting/vercel/README.md owns deployment and production-storage operations;
  CLOUD_SAVES.md and WASM.md explain persistence and exact runtime pins. Disposable
  development fixtures never authorize wiping published runs or the ledger.
- The low API exposes the complete semantic catalog. MCP/WebMCP and the high API
  may offer a different, higher-level vocabulary, with explicit mappings to the
  low-level operations. Run check:tools and evolve it to verify operation coverage
  and meaning, rather than requiring identical high/low tool counts. WebMCP
  and Bun stdio/HTTP MCP expose the navigation vocabulary generated from
  `protocol/agent.ts`. There is no MCP profile switch. Precise operations remain
  available through the low library, C API and NDJSON.
  Agent tools use plain names (`create`, `observe`, `inspect`, `eat`, `answer`),
  explicit `itemId` selectors and context-bound `value` answers. Generate syntax
  in the shared adapter; never rename low operations as a side effect or teach sample
  clients a different question contract. Inspect offers and question replies
  include executable adapter syntax without choosing an action for the player.
- Prefer replacing an awkward method and updating its consumers over adding a
  compatibility layer. Keep introductions short and link to the exact contract.

## Perceptual parity and UX

Before any UX work, read [web/neohack.dev/AGENTS.md](web/neohack.dev/AGENTS.md)
and [web/neohack.dev/DESIGN.md](web/neohack.dev/DESIGN.md). Follow the established
interaction and visual decisions, and update DESIGN.md when those decisions change.

- Human, accessible and agent interfaces should receive compatible descriptions
  of the same perceived scene. Presentation can differ; knowledge must not.
- Keep one coherent perception model across the map and local views. Represent
  apparent creatures, known objects and hazards as separate layers. Preserve
  uncertainty, visibility and remembered knowledge rather than guessing identity
  from a glyph, sprite, label or presentation shortcut.
- Expose canonical self-state through the semantic contract. Clients should not
  recover structured facts by parsing padded display strings.
- Explain failures using witnessed reasons. An eligible action is an attempt,
  not a safety guarantee or an omniscient prediction of success.
- Make useful information and controls easier to discover through clear text,
  keyboard/touch access and accessible descriptions. Do not silently select an
  item, confirm a warning, repeat an occupation or rescue a failed plan.
- Named operations are distinct from answering or cancelling a standing
  decision. Real decisions remain explicit, including when an agent is acting.
- Free observation queries consume neither engine input nor randomness. Actual
  elapsed turns and terminal facts outrank a client's intended action or outcome.
- The overnight run used an evolving, error-prone client; it was not a controlled
  study of NetHack's difficulty. Do not infer that monsters, hunger or paralysis
  need weakening from those deaths. Fix client/protocol defects and demonstrate
  them with focused scenarios; balance changes require their own justification.

## Session and protocol integrity

- Keep game semantics in the shared C implementation. TS, workers, MCP adapters,
  rendering and hosting must not acquire independent game rules or hidden state.
- Shared C navigation may compute routes from remembered perception. Label its
  policies (such as avoiding known traps) separately from physical movement
  eligibility. Higher-level adapters may execute explicitly requested bounded
  legs, stopping for genuine decisions, interruptions and changed conditions.
- MCP may own request IDs, revision tracking and response reconstruction; the
  engine still enforces exact receipts and stale-input checks. Require explicit
  run tokens, and never treat an uncertain response as permission to act again.
- Decision answers and cancellations carry the exact returned decision ID across
  every interface. Adapters must not substitute a newer standing question, even
  when its kind, labels or available answers match the earlier question.
- Use opaque item references. Never infer item identity from display labels,
  inventory slots or menu order.
- Preserve input journals, request reservations, exact receipts, engine/static
  data pins and pending-context integrity. Missing receipts mean uncertainty,
  not permission to execute again. Corruption is not silently truncated or fixed.
- Discovery describes actual backend guarantees. Memory is volatile; IndexedDB
  requires explicit origin/name ownership and awaited pre-input transactions.
- Resume uses the recorded engine package. New runs may select the current
  runtime; existing runs must never silently replay on an upgraded binary.

## Development compatibility

- Backwards compatibility is not a requirement. Replace obsolete implementations,
  formats, fallbacks and generated artifacts rather than preserving them.
- Do not add migrations, compatibility adapters, legacy runtime loaders or package
  archives to preserve old development saves. Those saves are disposable; start
  fresh after an incompatible change. This does not waive current-format
  integrity checks or the pins required to resume supported published runs.
- Existing local sessions are not migration fixtures. Test with new temporary
  stores only.

## Verification

Run checks appropriate to the affected layers. The core checks are:

```sh
make -C lib/neonethack test
npm ci --prefix lib/neonethack
npm test --prefix lib/neonethack
make -C lib/neonethack wasm
npm run --prefix lib/neonethack test:wasm
npm run --prefix lib/neonethack test:browser
node lib/neonethack/scripts/generate.ts --check
npm run --prefix lib/neonethack check:tools
```

For pixel UX changes, also run `bun run --cwd web/neohack.dev test`. For cloud
storage, runtime delivery or dashboard changes, run
`npm test --prefix hosting/vercel` after building the library and pixel client.
See each area's README for prerequisites and narrower test entry points.

Use actual engine/browser scenarios, including native/WASM and presentation
parity where relevant. Missing coverage is not a passing test. Never disable
Chromium sandboxing, weaken storage checks or rewrite recordings to make a test
pass. Native C calls must not change the host's signal handlers.

## Source and release hygiene

- Never publish local sessions, private journals/pins, credentials, SDK installs,
  dependencies or generated build output as source. Release binaries are separate
  artifacts accompanied by licenses and matching source.
- Keep NetHack notices and base attribution intact. Its NGPL obligations apply
  to derivatives. See [NOTICE.md](lib/neonethack/NOTICE.md) and
  [distribution guidance](lib/neonethack/docs/DISTRIBUTION.md).
- Do not push or change visibility without an explicit request. Passing local
  tests does not imply permission to commit.
