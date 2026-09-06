# TypeScript and MCP

## TypeScript

`neonethack` exports the runtime-independent `Neonethack`, `Game` and transport
interface. `neonethack/native` adds a Node child-process transport. Import world
model types from `neonethack/types`. No browser-facing module imports Bun, Node,
MCP or a UI framework.

```ts
const game = await nethack.create({ name: 'Ada', seed: 42 });
const food = await game.eat();
if (food.decision?.kind === 'item') {
  const chosen = food.decision.options[0]; // replace with caller's choice
  if (chosen) {
    const next = await game.answer(food.decision.id, {
      kind: 'item', item: { id: chosen.id },
    });
    // A warning is another choice, never implicit consent.
    console.log(next.decision);
  }
}
```

Every gameplay method resolves to a full immutable `Snapshot`; the game also
retains `state`, `observation` and `decision`. Concurrent method calls serialize
in invocation order. Inputs are copied before queueing, so caller mutation
cannot change a queued operation. The latest revision is used when it runs.

`Game` also exposes `throw`, `offer`, `cast`, `enhance`, `fire`, `quiver`,
`swap`, `twoWeapon`, `pay`, `chat`, `dip`, `rub`, `invoke`, `engrave`, `attack`
and `moveWithoutAttack`. Their arguments and subsequent decisions match the
[C protocol](PROTOCOL.md). Inspect `observation.knowledge` and item `known`
fields without parsing inventory labels. Use only returned choices; a target
decision's `allowedDirections` describes the offered directions. A counted
item decision accepts `{id, quantity}`; initial counts are supported by `drop`.
MCP/WebMCP generate all these named tools from the same catalog.

There is no hidden per-move observation request. Inspect the snapshot directly
or call `game.observe()` for a no-input read. `game.close()` retires that handle;
`nethack.resume(game.id)` returns a new live handle with the standing choice.
`nethack.close()` retires the transport and all engines it owns.

### Errors and uncertainty

`WorldError.response` contains a structured rejection and any returned recovery
context. A rejected operation does not silently drop the standing decision.
A transport failure throws `UncertainExecution`, whose `request` is the exact
immutable request that may have executed. It is also available as
`game.pendingRequest`. New operations are blocked while that request is unresolved.

For a recoverable transport connection, `game.retry()` retrieves the same
receipt. A native bridge timeout retires that bridge; create a new transport,
resume the same session, and use the saved request with `transport.send(request)`.
Do not generate another request ID to make the error go away. Inspecting the
world does not by itself prove whether an uncertain operation executed.

The low-level typed `nethack.request(method, params)` exposes the full contract
when explicit request IDs/revisions are needed. It returns structured errors
rather than throwing `WorldError`; transport errors still reject. It never
fills omitted parameters or retries.

## MCP

```sh
# After native and npm builds; all paths should be absolute in an MCP config.
NEONETHACK_EXECUTABLE=/path/to/build/native/neonethack \
  node lib/neonethack/dist/mcp/cli.js \
  /path/to/engine/playground/nethack \
  /path/to/engine/playground \
  /path/to/sessions
```

The stdio server uses the official MCP SDK for framing/initialization. stdout is
protocol-only. It advertises one tool per method:

- `session_create`, `session_observe`, etc.;
- `game_move`, `game_eat`, etc.;
- `decision_answer` and `decision_cancel`;
- `protocol_describe`.

Tools expose the same strict input schemas used at the C boundary. Listings omit
the optional repeated `outputSchema`; the compact response schema is available as
`compactResponseSchema` from `neonethack/mcp/tools` and in
`protocol/mcp-response.schema.json` for consumers that validate results.
Results are available in `structuredContent`, with an empty
`content` array. `session_observe` returns the entire perceived state;
ordinary observation responses are deltas. `session_create` accepts no arguments
to randomize the character and generate a name in C. Structured rejections set `isError`; a blocked
in-game attempt is not automatically a protocol error.

Only discovery/observation are marked read-only. Gameplay/decision idempotency
requires the advertised mandatory request ID and revision guard. Creation,
resume and close do not advertise retry-idempotency. Tool descriptions explain
actual costs, allowed targets, candidate discovery, hidden-state limits and
consent. Arguments are forwarded intact, not sanitized into different commands.
Shared decision, retry and delta guidance appears in MCP initialization and once
in the `protocol_describe` tool description, making it available to WebMCP too.
Native MCP, Node MCP and WebMCP use the same generated tool definitions. Full
protocol documentation remains in [PROTOCOL.md](PROTOCOL.md).

`createMcpServer(transport)` accepts any conforming library transport, keeping
MCP independent of game semantics. HTTP hosting, authentication and old web-app
management routes are not part of this package.
