# TypeScript and MCP

## TypeScript

In Node, the default `Nethack` export from `neonethack` supplies native engine
and data defaults; construct it with `new Nethack()`. Named `Neonethack` and
`Game` exports are runtime-independent clients for an explicit transport.
`neonethack/low` exposes the complete named protocol API; `neonethack/high`
adds the Hero, event and script interfaces, retaining the low API through `low`.
`neonethack/native` provides explicit native transport configuration; WASM
uses `neonethack/wasm`. Import model types from `neonethack/types`.
Browser-facing modules do not import Node or Bun. See [Hero](HERO.md) for the
higher-level interface and the runnable [quickstart](QUICKSTART.md).

```ts
const game = await nethack.create({ name: 'Ada', seed: 42 });
const food = await game.eat();
if (food.decision?.kind === 'item') {
  // This example deliberately declines. A real caller chooses an opaque option ID.
  await game.cancel(food.decision.id);
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
MCP/WebMCP map these operations to the navigation vocabulary described below.

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

## Bun/WASM MCP

`make mcp` installs `bin/neohack-mcp` in the repository (override
`MCP_PREFIX`). Bun runs the CLI; the actual game is the same C WASM used by
WebMCP. `mcp/service.ts`, `mcp/agent.ts` and the shared Navigator own all
schemas, tool execution, guards, named decisions, recovery and presentation.
The browser registration and stdio/HTTP framing do not implement parallel rules.
There is no native C MCP, profile switch or fallback gameplay server.

```sh
./bin/neohack-mcp --sessions /private/new-wasm-sessions
./bin/neohack-mcp --http 8080 --sessions /private/new-wasm-sessions
```

Every surface returns identical tool names/descriptions/schemas and identical
`structuredContent` plus a JSON text content block. `go`, `explore`,
`descend`, `navigation` and `route` are available everywhere. Route
planning remains perception-only C; ordinary failed route queries spend zero
turns. Movement, searching, rest, door attempts and genuine decisions may cost
turns. Navigation is bounded and stops for witnessed danger, changed conditions
and questions. This replacement does not relax those stops or change pet, food,
combat or identification rules.

### Concurrent games and durable storage

Each run has a separate worker and `runs/<sessionId>/journal.sqlite` with
an immutable runtime descriptor. SQLite WAL with synchronous FULL commits a
request reservation before C receives input, then atomically records completion
and cursor. Live turns never read/rewrite the historical input buffer. The same
worker journal/resume/checkpoint code runs in the browser with IndexedDB.

Process leases prevent concurrent ownership of a disk journal; another process
can acquire it after its owner exits. Failed worker operations remain uncertain;
no second gameplay request is admitted until recovery. Restart the server and
explicitly resume after a failed worker. The reserved exact input reconstructs
against its original pin, and receipts stay available. Corruption fails closed.
Runtime directories are content-addressed, atomically published and verified;
new versions affect new games, never silently change existing pins.

Same-run calls capture the shared adapter revision when admitted and serialize;
stale queued calls submit no engine input. Different runs have independent
workers. `suspend` closes the game without quitting; `resume` is explicit.
Pending answers/cancels always carry the exact returned decisionId. SIGTERM,
SIGINT and stdin EOF stop admission and drain accepted work before shutdown;
a 90-second shutdown deadline leaves durable reservations for recovery.

Recovery is shared per run, not per caller. A completely lost outer reply can
lose its operation ID; another participant's latest receipt is not evidence of
that lost action. Do not blindly resubmit create or a navigation leg. `--list`
shows local run tokens for inspection; it does not select or advance a run.

### Streamable HTTP

The loopback-only endpoint is `http://127.0.0.1:8080/mcp`. It supports the
2025-03-26, 2025-06-18 and 2025-11-25 initialize/notification handshake and the
2026-07-28 per-request metadata/discover interface. Explicit short sessionId
arguments select games; no transport session header selects state. HTTP modern
responses add only resultType/server metadata to the shared tool envelope.
Host/Origin are checked, bodies are limited to 64 KiB (UTF-8), and malformed or
duplicate-key requests are rejected before dispatch. The semantic input limit
remains 4096 UTF-8 bytes. Notifications cannot invoke gameplay. Stdout contains
only JSON-RPC; diagnostics go to stderr.

HTTP disconnect does not cancel accepted work. Stdio cancellation can stop a
navigation leg between actions; already accepted inputs are never undone. This
local endpoint does not provide remote-user authentication. Keep it on loopback.

### Low and high APIs

`neonethack/high` names the ergonomic `Neonethack`, `Game`, `Hero` and script
lifecycle API used throughout this guide. The root `neonethack` export remains
its convenient native entry point. `neonethack/low` exposes exact protocol calls:

```ts
import { LowLevel } from 'neonethack/low';

const low = new LowLevel(transport);
console.log(low.tools); // the complete precise semantic catalog
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

The command verifies exact agreement within each vocabulary and explicit
coverage of low operations by agent tools. It exits nonzero on missing, extra
or duplicate tools, schema/annotation drift, dispatch mismatches or failed
probes. It compares against the source catalogs, not a hardcoded count. It
checks package low/high exports, WebMCP registration and dispatch, real Bun/WASM
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
