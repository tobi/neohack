# Play with agent-browser and WebMCP

Use agent-browser to play [NetHack at neohack.dev](https://neohack.dev) through
its WebMCP tools. You do not need to clone this repository or run a game server.
The game runs in the browser, and each tool result updates the same visible HUD
and durable save used by keyboard and touch input.

## Open the live game

Install [agent-browser](https://github.com/vercel-labs/agent-browser#installation)
and its Chrome for Testing browser:

```sh
npm install -g agent-browser
agent-browser install
```

Use a version with `webmcp list` and `webmcp invoke`. The walkthrough was checked
with **agent-browser 0.36.0 and Chrome for Testing 152.0.7977.82**. WebMCP is
experimental; older Chrome versions may lack its CDP domain even when page-level
WebMCP APIs exist. Upgrade both the CLI and browser if needed.

Managed Chrome enables WebMCP by default. In one shell, select a dedicated browser
session and a persistent profile outside the repository:

```sh
export AGENT_BROWSER_SESSION=neonethack
export AGENT_BROWSER_PROFILE="$HOME/.neonethack-agent-profile"
agent-browser open https://neohack.dev
agent-browser wait 'pixel-nethack[data-webmcp="ready"]'
agent-browser webmcp list
agent-browser webmcp invoke protocol_describe --params '{}'
```

Add `--headed` to `open` to watch the game. Use the same profile, origin and WASM
package when resuming a save. Cookie/localStorage exports are not a replacement
for this game's IndexedDB journal. Close human menus before issuing game tools.

If attaching to an existing Chrome instead, launch it with a dedicated profile,
`--enable-experimental-web-platform-features` and a loopback remote-debugging port.
Pass `--cdp PORT` on every agent-browser command. Keep Chrome's sandbox enabled.

## Create a game and inspect it

For a fully random character with a generated name, invoke `session_create`
with `--params '{}'`. Supply only the identity fields you want to choose.

The examples below use `jq` and keep request/response files in a new temporary
directory. Tool arguments are the schema's parameters directly, with no enclosing
`method` or `params` object.

```sh
PLAY_DIR=$(mktemp -d)
agent-browser --json webmcp invoke session_create \
  --params '{"name":"Ada","seed":42,"role":"valkyrie"}' > "$PLAY_DIR/create.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/create.json"
jq '.data.output.structuredContent' "$PLAY_DIR/create.json" > "$PLAY_DIR/frame.json"
jq '{sessionId, revision, observation, decision}' "$PLAY_DIR/frame.json"
GAME_ID=$(jq -er '.sessionId' "$PLAY_DIR/frame.json")
```

Run creation once. If its reply is lost, inspect the visible adventure or saved
adventure list before creating another game. `session.create` has no retry ID.
On success, check the game result as well as the CLI's `success`: errors reported
by the game appear in `data.output.isError` and the structured response's `error`.
Stop if a check fails; inspect the error before running the next block.

To use an already open game, read its public DOM identifier instead of creating:

```sh
GAME_ID=$(agent-browser get attr pixel-nethack data-session-id)
```

Read the current world for free, including any standing decision:

```sh
agent-browser --json webmcp invoke session_observe \
  --params "$(jq -nc --arg sid "$GAME_ID" '{sessionId:$sid}')" > "$PLAY_DIR/observe.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/observe.json"
jq '.data.output.structuredContent' "$PLAY_DIR/observe.json" > "$PLAY_DIR/frame.json"
```

## Take a turn

If `decision` is null and the game is active, search once. Each new input gets a
unique request ID and the revision from the latest observation. Save the exact
parameters before invoking the tool:

```sh
REQUEST_ID=$(node -e 'console.log(crypto.randomUUID())')
REQUEST_FILE="$PLAY_DIR/$REQUEST_ID.json"
jq --arg rid "$REQUEST_ID" \
  '{sessionId, expectedRevision:.revision, requestId:$rid}' \
  "$PLAY_DIR/frame.json" > "$REQUEST_FILE"
agent-browser --json webmcp invoke game_search \
  --params "@$REQUEST_FILE" > "$PLAY_DIR/search.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/search.json"
jq '.data.output.structuredContent' "$PLAY_DIR/search.json" > "$PLAY_DIR/frame.json"
jq '{revision, outcome, events, decision, observation}' "$PLAY_DIR/frame.json"
```

For movement, first inspect `observation.neighborhood` or query a direction:

```sh
jq '{sessionId, expectedRevision:.revision, target:{direction:"east"}}' \
  "$PLAY_DIR/frame.json" > "$PLAY_DIR/actions.json"
agent-browser webmcp invoke session_actions --params "@$PLAY_DIR/actions.json"
```

This query costs no turn. Choose a direction from perceived information; an
available attempt is not a promise of safety. If you choose to step east:

```sh
REQUEST_ID=$(node -e 'console.log(crypto.randomUUID())')
REQUEST_FILE="$PLAY_DIR/$REQUEST_ID.json"
jq --arg rid "$REQUEST_ID" \
  '{sessionId, expectedRevision:.revision, requestId:$rid, direction:"east"}' \
  "$PLAY_DIR/frame.json" > "$REQUEST_FILE"
agent-browser --json webmcp invoke game_move \
  --params "@$REQUEST_FILE" > "$PLAY_DIR/move.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/move.json"
jq '.data.output.structuredContent' "$PLAY_DIR/move.json" > "$PLAY_DIR/frame.json"
```

A move attempts one adjacent step and can bump a creature or door. Read the
resulting observation before choosing the next input.

Other tools include `game_wait`, `game_pickup`,
`game_apply` and `game_pray`. Use `webmcp list` for exact
schemas. Pass returned item IDs, not inventory letters or labels. Execute one
input at a time; turns and revisions are different counters.

## Answer decisions and recover replies

When `decision` is present, answer or cancel it before another game operation.
For a confirmation that you choose to decline, write a new request file with:

```json
{
  "sessionId": "SESSION_ID_FROM_RESPONSE",
  "requestId": "NEW_UNIQUE_REQUEST_ID",
  "expectedRevision": 3,
  "decisionId": "DECISION_ID_FROM_RESPONSE",
  "answer": { "kind": "confirmation", "confirm": false }
}
```

Replace all IDs and the illustrative revision with the latest response values,
then invoke `decision_answer`. Other answers are typed item, target,
choice or text values; follow the discovered schema and returned choices.
`decision_cancel` takes the same guards and `decisionId`, without
`answer`, and is valid only for a cancellable decision. Inspect the next result:
an answer can produce another decision.

After a timeout or lost reply, keep the **same tool and exact request file** for
receipt recovery. If the transport failed, reload and resume the same adventure
first, then retry that request. Do not create a new request ID to repeat an
uncertain action. A recovered receipt can be historical; use `session.observe`
after recovery for the current world. Corruption or missing receipts must be
resolved before new input.

For slow invocations, agent-browser also supports `--detach`, followed by
`webmcp result INVOCATION_ID`. That invocation ID is a browser-tool handle, distinct
from the game's `requestId`. `webmcp cancel` cannot undo submitted engine input.

## Stop and resume

Close the game engine while preserving its journal and any standing decision:

```sh
agent-browser webmcp invoke session_close \
  --params "$(jq -nc --arg sid "$GAME_ID" '{sessionId:$sid}')"
agent-browser close
```

While the run is open, bookmark its full page URL. On the live site, wait for
**Saved online** before switching browsers. Keep the URL private: it includes
the key to the saved vault. Opening that bookmark resumes the selected run
through the C engine. See [cloud saves](CLOUD_SAVES.md) for details.

Keep `GAME_ID` for the next visit. Reopen the same origin/profile/package and use
`session_resume` with `{"sessionId":"YOUR_SAVED_GAME_ID"}`, or choose
**Continue previous run** in the UI. Closing is not an in-game quit.

## Connect an MCP agent

To expose agent-browser's browser and WebMCP commands through stdio MCP:

```json
{
  "mcpServers": {
    "agent-browser": {
      "command": "agent-browser",
      "args": ["mcp", "--tools", "core,webmcp"]
    }
  }
}
```

A useful instruction for the agent:

> Open https://neohack.dev and discover its WebMCP tools. Start one new Valkyrie
> game, or use the adventure I selected. Play one input at a time from returned
> observations. Keep request IDs and revisions, answer decisions explicitly, and
> stop on uncertainty or game over. Never infer hidden map cells or item identity.

See the [agent-browser command reference](https://agent-browser.dev/commands) for
CLI flags, and [WebMCP](WEBMCP.md) for the adapter and storage contract.

## Run a local development copy

For development, [build and start the pixel client](../../../example/pixel-bun/README.md#run-locally)
and replace `https://neohack.dev` in the commands with `http://127.0.0.1:3333`.
Local and live sites have separate browser storage and saves.

Read `structuredContent` from tool results. Ordinary observation responses are
[compact deltas](PROTOCOL.md#mcp-observation-presentation); `session.observe`
resynchronizes a lost baseline. Full action offers are available via
`session.actions`. Do not assume omitted fields or map cells disappeared.

## Creation timeout checklist

Creation is not an idempotent input operation. A successful CLI envelope only
means the browser command was handled: `data.status: "timed_out"` is not a game
result, and `data.output.isError: true` is not a validated frame. Before using a
result, require a completed invocation, non-error output, no structured `error`,
and a materialized snapshot with `sessionId`, numeric `revision`, `observation`, `outcome`,
`decision` and `ended`. MCP/WebMCP may return a compact delta: resolve its
baseline first, or use `session.observe` for a standalone full snapshot before
replanning. Never treat omitted delta fields as missing game facts or feed a
compact response directly to the full-frame reference consumer. Never extract
an ID from an error or empty output.

For a slow creation, invoke once with `--detach`, retain the returned invocation
ID and retrieve it with `webmcp result INVOCATION_ID`. If that result is missing,
read the owning page's `pixel-nethack[data-session-id]` and observe that session.
Check the saved-adventure UI on the same origin/profile if the page restarted.
An empty DOM identifier while startup is in flight proves nothing. Wait for the
original invocation or stop for investigation; do not submit another creation.
A rejected or cancelled supervisor command cannot prove that the engine received
no input. Coordinate one input owner, including keyboard, touch and other agents.

For diagnosis, record the public library version, backend, capability profile,
client code revision and actual `WasmTransport.buildId` (the complete package
identity checked at initialization). Keep vault URLs, keys, profile paths and
journals private. Discovery on an old package may omit capabilities: do not infer
support or load newer binaries to repair it. Memory storage cannot survive worker
loss. Durable recovery requires the same origin, explicit IndexedDB name and
original complete package, with its Web Lock released by the previous owner.

The focused `tests/wasm/lifecycle.test.mjs` scenario creates in a fresh browser
store, delays or drops the reply after the page owns the frame, observes the
public ID, and reopens the same package/store. This tests recovery mechanics;
it does not reproduce every CDP/agent-browser timeout or prove an old package's
startup performance.

## Manual reference consumer

The optional `neonethack/reference-client` module demonstrates a deliberately
small manual consumer of `Game`. It is not an autoplayer or a complete command
palette. It never starts a new life, selects food/equipment, consents, repeats a
search or resumes an occupation for the player. Other named library operations
remain available to a separately implemented capable client. The [command coverage audit](COMMAND_COVERAGE.md) documents current endgame
limits; this example does not demonstrate ascension.

```ts
import { ReferenceClient } from 'neonethack/reference-client';

const player = new ReferenceClient(game); // Give it exclusive ownership of Game.
render(player.view); // Render the entire perceived state, including vitals.

// Bind each handler to a separate explicit player choice. Neither calls the other.
async function declineWarning() {
  const decision = player.view.state.decision;
  if (decision?.kind !== 'confirmation') throw Error('No confirmation to decline.');
  await player.choose({ kind: 'answer', decisionId: decision.id,
    answer: { kind: 'confirmation', confirm: false } });
  render(player.view); // Complete returned observation: stop and replan here.
}

async function deliberatelyRequestPrayer() {
  await player.choose({ kind: 'pray' });
  render(player.view); // A reattempt has a new decision.id; it still needs a choice.
}
```

Display the confirmation's exact `about` text and optional `context` as returned.
Context identifies the initiating public action and any supplied direction/item
ID; it does not infer a hazard reason or promise safety. Older packages may omit
it. After declining, inspect the complete returned snapshot before choosing a
different plan or deliberately requesting the action again. A reattempt is new
input with a new request ID, allowed only after the original result is settled;
it is distinct from exact receipt recovery after a lost reply. Never reuse an
old decision ID or automatically invoke the reattempt handler to clear a warning.

`view.state` retains world appearances, visibility, freshness, hunger, burden,
conditions, events and `ended/end` without deriving identity or safety from text.
A remembered floor is still a known floor. Render hunger/conditions alongside
nearby creatures before asking for another choice; combat must not hide them.
The sample never calls a corpse safe, infers attitude from `kind:creature`, or
computes a prayer cooldown. The player owns those uncertain decisions.

`choose({kind:'retreatStep', direction})` queries the current public movement
intent and accepts only an attemptable ordinary step with no disclosed occupant,
restriction or hazard. It rejects creature/ally bumps, possible pushes, unknown
terrain and stale queries. This excludes disclosed attack steps; it cannot
promise a safe retreat, reveal hidden threats or guarantee the eventual outcome.
Always read the returned outcome and elapsed turns. A normal manual `move`
remains an explicit choice to accept the engine's ordinary risks.

The last 16 attempts are bounded diagnostic memory. `noProgress` never writes a
wall into the map. Repeated A-B movement stops further movement until the player
reviews and calls `acknowledgeAttempts()`. Search has no permanent counter: each
explicit selection searches once, including after earlier bursts. No timer or
loop supplies input during paralysis; only a returned ready `inputGate` permits
a new ordinary operation. Known standing decisions use their actual IDs;
unsupported decisions and absent/inconsistent gates stop the sample.

A lost reply retains `game.pendingRequest`; `player.recover()` retries that exact
request, then observes the current state. It never replaces the request ID. If
the transport itself died, retain the original request outside this object,
retire the old owner, reopen the original package/store, resume the same ID and
use the low-level transport to recover the exact receipt before handing a fresh
`Game` to this consumer. An unknown receipt, damaged storage or missing history
remains a stop. Neither an observation nor a new consumer resolves uncertainty.
