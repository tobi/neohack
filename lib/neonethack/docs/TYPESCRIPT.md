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

## Native MCP

MCP is implemented in C. Build with `make -C lib/neonethack` (requires
pkg-config and libevent 2.1 development headers/libraries), then run:

```sh
lib/neonethack/build/native/neonethack-mcp \
  /path/to/engine/playground/nethack \
  /path/to/engine/playground /private/sessions
```

The default transport is stdio: newline-delimited JSON-RPC initialization,
`ping`, `tools/list` and `tools/call`. Stdout is protocol-only. There is no Node
server adapter, JavaScript server launcher or bundled JavaScript runtime.

The generated tool names, input schemas, annotations and response schema remain
the same for native MCP and WebMCP. Tools include `session_create`,
`session_observe`, named `game_*` actions, `decision_answer`, `decision_cancel`
and `protocol_describe`. There is no generic `act` tool. Arguments are forwarded
intact to public `nnh_dispatch`; the C driver validates them and owns gameplay.

Results are in `structuredContent` with an empty `content` array. Structured
rejections set `isError`; a blocked in-game attempt is not automatically a
protocol error. Process failures return a textual `isError` explaining that
execution may be uncertain. Tool listings omit the optional repeated output
schema; `compactResponseSchema` is available from `neonethack/mcp/tools` and in
`protocol/mcp-response.schema.json`. `CompactObservationReader` remains available
from `neonethack/mcp` for consumers of stdio observation deltas.

### Concurrent games and state directories

The C MCP process uses a libevent event loop and a dedicated C worker process
for each active game. Each worker calls the public C API serially and owns its
isolated NetHack engine process. Calls with the same `sessionId` queue in arrival
order; different games can execute and replay concurrently. No C contexts are
called concurrently within one process.

Every `session_create` has a dedicated `SESSIONS/<sessionId>/` directory with its
private playground, journals, receipts, semantic state and runtime pins. Only
immutable engine cache entries are shared in the parent directory; their
publication never replaces an existing entry. The C driver's exclusive leases
still protect each game's mutable state.

`session_close` releases the worker and engine before replying; its directory
remains for explicit `session_resume`. Queued calls retain their original
arguments, request ID and revision. Closing and resuming a game does not affect
other games. There is no implicit resume, retry, confirmation, revision adjustment
or decision answer. Workers are retained until close or server shutdown; close
games that no longer need to stay loaded.

A failed or timed-out worker and its engine are retired together. Other games
remain available. Explicitly resume after a failure; retry only the same recorded
request ID and payload. Creation has no retry ID, so never blindly resubmit it.
A worker response is bounded to 8 MiB and an in-flight request has a 150-second
transport timeout. SIGINT/SIGTERM stops accepting new requests, drains accepted
work and closes the workers. Stdio EOF does the same.

### Streamable HTTP

Add `--http PORT` to the same native executable:

```sh
lib/neonethack/build/native/neonethack-mcp --http 8080 \
  /path/to/engine/playground/nethack \
  /path/to/engine/playground /private/sessions
```

The endpoint is `http://127.0.0.1:8080/mcp`, implementing
[MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http):
one POST per request, JSON replies, per-request metadata and `server/discover`.
There is no HTTP initialization handshake, `Mcp-Session-Id`, GET stream or DELETE
session. MCP 2025-11-25 clients can use stdio. HTTP replies use the existing
`update.kind: "snapshot"` format so each response is independent of other clients'
observation history. The MCP envelope includes `resultType: "complete"` and
server identity metadata. Game `sessionId` is still an explicit tool argument.

```sh
curl http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  --data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

`tools/call` also requires `Mcp-Name` matching `params.name`. Every HTTP request
needs the protocol version and client capabilities in `params._meta`; these are
MCP metadata, not extra fields in tool arguments. Headers are checked against the
body before dispatch. Unsupported versions return error `-32022` listing supported
versions; mismatched or missing headers return `-32020`.

HTTP binds only to IPv4 loopback and validates Host and Origin. It is a local
service with one trust domain: clients can access the store's games by ID. Remote
authentication and per-user access control are not provided. HTTP bodies are
limited to 64 KiB and headers to 16 KiB; the existing public semantic request
limit remains 4096 UTF-8 bytes. Libevent supplies the HTTP parser, bounded framing
and connection handling; there is no separate HTTP gameplay engine.

### Low and high APIs

`neonethack/high` names the ergonomic `Neonethack`, `Game`, `Hero` and script
lifecycle API used throughout this guide. The root `neonethack` export remains
its convenient native entry point. `neonethack/low` exposes exact protocol calls:

```ts
import { LowLevel } from 'neonethack/low';

const low = new LowLevel(transport);
console.log(low.tools); // the same named tools and input schemas as MCP/WebMCP
await low.call('session_observe', { sessionId });
```

Existing high-level clients and games also expose `.low`. Low-level callers
supply exact request IDs and revisions and handle responses themselves; these
calls do not update the high-level Game's cached observation or run its lifecycle
hooks. Do not mix them with in-flight Game/Hero operations. Prefer Game/Hero for
ordinary scripts, where serialization, explicit decisions and receipts matter.

The workshop supports `neonethack`, `neonethack/high` and `neonethack/low` imports
with TypeScript completion. Its tool vocabulary is complete, but its transport
is confined to the supplied run. The host owns creation: `session_create` returns
an explicit permission error. Other session operations require that run's ID;
`protocol_describe` is available without a session. This is an ownership boundary,
not a different set of game actions.

### Check tool parity

From the repository root, after building the native executable and installing
library dependencies and Bun:

```sh
make -C lib/neonethack test
npm run --prefix lib/neonethack check:tools
npm run --prefix lib/neonethack check:tools -- --web https://neohack.dev
node lib/neonethack/scripts/check-tools.mjs --json
```

The command exits nonzero on missing, extra or duplicate tools, differing
schemas/descriptions/read-only annotations, dispatch mismatches or failed
probes. It compares against the source catalog, not a hardcoded count. It
checks package low/high exports, WebMCP registration and dispatch, real native
stdio/HTTP discovery and the bundled workshop module loader. CI runs the same
command. `--http URL` substitutes an existing MCP endpoint; `--web URL` additionally
checks actual page registration in sandboxed Chromium (set `CHROMIUM` if needed).
Remote checks only discover tools; they never create or play a run. A pinned
older runtime may legitimately differ from current source; the report flags that
difference without upgrading or replaying anything.

## Workshop scripts in JavaScript

Create a definition at the top of `main.js`, export it, and register plain event
handlers. The workshop supplies the live session when you run the script.

```js
import { defineBot } from 'neonethack';

const bot = defineBot({ name: 'First steps' });
export default bot;

bot.on('enterLevel', ({ to, log }) => {
  log('Entered', to.depthLabel);
});

bot.on('turn', async ({ hero }) => {
  await hero.search();
  hero.stop();
});
```

`bot.on()` receives the event payload plus `hero`, `game`, and `log`. Register
handlers before running. `start` runs once before observations and is the place
to register controls. Keep engine actions in one awaited `turn` handler; other
observation notifications stay read-only. Event return values retain the same
script-state behavior, including `null` to yield. `bot.on()` returns a function
that unsubscribes the handler. A live `hero.on(event, handler)` receives the plain
event payload and also returns an unsubscribe function; it supports `{ once: true }`.

At `/bots`, choose Create a script or an example. Example source is not saved
until Save my copy creates a private project in your account. Each saved project
has a stable `/bots?script=<id>` URL requiring its owner's account. Subsequent
saves update that project; opening an example again creates a separate draft.
All workshop source filenames end in `.js`; Format uses Prettier on the current
file. JavaScript keeps cross-file completion and documentation from the SDK types.
