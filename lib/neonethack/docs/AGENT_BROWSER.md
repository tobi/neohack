# Play with agent-browser and WebMCP

agent-browser can discover and invoke the pixel client's game tools directly.
The game runs in the browser, and each tool result updates the same visible HUD
and durable save used by keyboard and touch input.

## Start the client and browser

Build and start the [pixel client](../../../example/pixel-bun/README.md#run).
The default address is `http://127.0.0.1:3333`; remote access requires HTTPS.

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
agent-browser open http://127.0.0.1:3333
agent-browser wait 'pixel-nethack[data-webmcp="ready"]'
agent-browser webmcp list
agent-browser webmcp invoke neonethack_protocol_describe --params '{}'
```

Add `--headed` to `open` to watch the game. Use the same profile, origin and WASM
package when resuming a save. Cookie/localStorage exports are not a replacement
for this game's IndexedDB journal. Close human menus before issuing game tools.

If attaching to an existing Chrome instead, launch it with a dedicated profile,
`--enable-experimental-web-platform-features` and a loopback remote-debugging port.
Pass `--cdp PORT` on every agent-browser command. Keep Chrome's sandbox enabled.

## Create a game and inspect it

The examples below use `jq` and keep request/response files in a new temporary
directory. Tool arguments are the schema's parameters directly, with no enclosing
`method` or `params` object.

```sh
PLAY_DIR=$(mktemp -d)
agent-browser --json webmcp invoke neonethack_session_create \
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
agent-browser --json webmcp invoke neonethack_session_observe \
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
agent-browser --json webmcp invoke neonethack_game_search \
  --params "@$REQUEST_FILE" > "$PLAY_DIR/search.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/search.json"
jq '.data.output.structuredContent' "$PLAY_DIR/search.json" > "$PLAY_DIR/frame.json"
jq '{revision, outcome, events, decision, observation}' "$PLAY_DIR/frame.json"
```

For movement, first inspect `observation.neighborhood` or query a direction:

```sh
jq '{sessionId, expectedRevision:.revision, target:{direction:"east"}}' \
  "$PLAY_DIR/frame.json" > "$PLAY_DIR/actions.json"
agent-browser webmcp invoke neonethack_session_actions --params "@$PLAY_DIR/actions.json"
```

This query costs no turn. Choose a direction from perceived information; an
available attempt is not a promise of safety. If you choose to step east:

```sh
REQUEST_ID=$(node -e 'console.log(crypto.randomUUID())')
REQUEST_FILE="$PLAY_DIR/$REQUEST_ID.json"
jq --arg rid "$REQUEST_ID" \
  '{sessionId, expectedRevision:.revision, requestId:$rid, direction:"east"}' \
  "$PLAY_DIR/frame.json" > "$REQUEST_FILE"
agent-browser --json webmcp invoke neonethack_game_move \
  --params "@$REQUEST_FILE" > "$PLAY_DIR/move.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/move.json"
jq '.data.output.structuredContent' "$PLAY_DIR/move.json" > "$PLAY_DIR/frame.json"
```

A move attempts one adjacent step and can bump a creature or door. Read the
resulting observation before choosing the next input.

Other tools include `neonethack_game_wait`, `neonethack_game_pickup`,
`neonethack_game_apply` and `neonethack_game_pray`. Use `webmcp list` for exact
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
then invoke `neonethack_decision_answer`. Other answers are typed item, target,
choice or text values; follow the discovered schema and returned choices.
`neonethack_decision_cancel` takes the same guards and `decisionId`, without
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
agent-browser webmcp invoke neonethack_session_close \
  --params "$(jq -nc --arg sid "$GAME_ID" '{sessionId:$sid}')"
agent-browser close
```

Keep `GAME_ID` for the next visit. Reopen the same origin/profile/package and use
`neonethack_session_resume` with `{"sessionId":"YOUR_SAVED_GAME_ID"}`, or choose
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

> Open the pixel client and discover its WebMCP tools. Start one new Valkyrie
> game, or use the adventure I selected. Play one input at a time from returned
> observations. Keep request IDs and revisions, answer decisions explicitly, and
> stop on uncertainty or game over. Never infer hidden map cells or item identity.

See the [agent-browser command reference](https://agent-browser.dev/commands) for
CLI flags, and [WebMCP](WEBMCP.md) for the adapter and storage contract.
