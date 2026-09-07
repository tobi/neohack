# Play with agent-browser and WebMCP

Open [neohack.dev](https://neohack.dev) and play through the browser’s WebMCP
tools. The agent shares the human’s visible game, explicit decisions and save.
No repository checkout or gameplay server is needed.

## Open and discover

Install [agent-browser](https://github.com/vercel-labs/agent-browser#installation)
and its managed browser. Use a version supporting `webmcp list` and `webmcp invoke`;
previous browser integration was checked with agent-browser 0.36.0 and Chrome for
Testing 152.0.7977.82. Keep Chrome’s sandbox enabled.

```sh
npm install -g agent-browser
agent-browser install
export AGENT_BROWSER_SESSION=neonethack
export AGENT_BROWSER_PROFILE="$HOME/.neonethack-agent-profile"
agent-browser open https://neohack.dev
agent-browser wait 'pixel-nethack[data-webmcp="ready"]'
agent-browser webmcp list
agent-browser webmcp invoke help --params '{}'
agent-browser webmcp invoke help --params '{"name":"go"}'
```

Add `--headed` to watch. Keep the same browser profile and origin to retain the
IndexedDB journal; cookie/localStorage exports do not replace it. Close human
menus before agent input. These commands describe the current navigation-only
source contract. If the deployed build does not expose `go`, check its version
instead of assuming an older tool has the same meaning.

## Create or observe one run

The shell examples use `jq`. Arguments are the tool’s parameters directly.
An empty creation object chooses a random character and generated name; specify
only the identity fields you want to choose.

```sh
PLAY_DIR=$(mktemp -d)
agent-browser --json webmcp invoke session_create \
  --params '{"seed":42,"role":"valkyrie"}' > "$PLAY_DIR/create.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/create.json"
jq '.data.output.structuredContent' "$PLAY_DIR/create.json" > "$PLAY_DIR/frame.json"
GAME_ID=$(jq -er '.sessionId' "$PLAY_DIR/frame.json")
```

Run creation once. If its reply is lost, retrieve the original invocation or
inspect the owning page before creating again. An already open game exposes its
public token through `agent-browser get attr pixel-nethack data-session-id`.
Observe it for free:

```sh
agent-browser --json webmcp invoke session_observe \
  --params "$(jq -nc --arg sid "$GAME_ID" '{sessionId:$sid}')" > "$PLAY_DIR/observe.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/observe.json"
jq '.data.output.structuredContent' "$PLAY_DIR/observe.json" > "$PLAY_DIR/frame.json"
```

Check both the CLI envelope and game result. A timed-out invocation is not a
frame. Require a session token, observation, outcome, decision and ended status;
stop on errors. MCP/WebMCP returns full observations and witnessed summaries,
not deltas the caller must merge.

## Navigate and answer questions

MCP manages request IDs, revisions and pending question context. You pass the
short `sessionId` on every call and choose one operation at a time.

```sh
agent-browser webmcp invoke session_actions \
  --params "$(jq -nc --arg sid "$GAME_ID" '{sessionId:$sid,target:{direction:"east"}}')"
agent-browser --json webmcp invoke game_search \
  --params "$(jq -nc --arg sid "$GAME_ID" '{sessionId:$sid,turns:1}')" > "$PLAY_DIR/search.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/search.json"
jq '.data.output.structuredContent' "$PLAY_DIR/search.json" > "$PLAY_DIR/frame.json"
```

Inspect the returned question before another action. To navigate, choose a
perceived destination and invoke `go` with `{sessionId,to:{x,y},maxActions:8}`.
The shared navigator plans known routes and stops on decisions or changed
circumstances. `explore` requests one exploration leg; `descend` follows disclosed
stairs. Neither is an endless autoplay command.

The 9×9 neighborhood is a destination-selection area. Only the eight adjacent
squares represent single steps. To deliberately attempt an ordinary step east,
including its normal bumps or attempts to open a door:

```sh
jq '{sessionId,to:{x:(.observation.you.x+1),y:.observation.you.y},force:true}' \
  "$PLAY_DIR/frame.json" > "$PLAY_DIR/move.json"
agent-browser --json webmcp invoke go \
  --params "@$PLAY_DIR/move.json" > "$PLAY_DIR/moved.json"
jq -e '.success == true and .data.output.isError == false' "$PLAY_DIR/moved.json"
jq '.data.output.structuredContent' "$PLAY_DIR/moved.json" > "$PLAY_DIR/frame.json"
```

Refresh `frame.json` after every operation before using it for another target.
`force:true` permits only adjacent ordinary movement: it does not bypass rules,
confirmations or standing decisions, and is not force attack. Use `attack` for a
deliberate adjacent attack. Eligibility is not a safety guarantee.

Answer a standing question explicitly. For a confirmation you choose to decline:

```sh
agent-browser webmcp invoke decision_answer \
  --params "$(jq -nc --arg sid "$GAME_ID" '{sessionId:$sid,answer:{kind:"confirmation",confirm:false}}')"
```

`decision_cancel` takes only `sessionId` and works only for cancellable questions.
The adapter binds answers to its observed question; do not send a decision ID or
revision. Item references remain opaque. Choice answers accept returned readable
names or IDs; an ambiguous name returns candidates. Use `help` with a tool’s
`name` for its schema. An answer can produce another question.

## Recover and return

After a lost input reply, **do not invoke the action again**. `retry({sessionId})`
recovers the adapter’s retained uncertain input or latest receipt, never a whole
navigation leg. `receipt({sessionId,operationId})` reads a known historical receipt
without rewinding the world. Observe before choosing another action. If a page
restart lost the adapter’s uncertain-operation context, do not assume a new
adapter can reconstruct it. Missing receipts remain uncertainty.

For slow commands use agent-browser’s `--detach`, retain its invocation ID and
retrieve it with `webmcp result INVOCATION_ID`. That browser handle differs from
an adapter `operationId`. Cancelling a browser invocation cannot undo engine
input. A human changing the run requires observation and reconsideration, not
an automatic retry of the old plan.

Bookmark the run’s full URL. Wait for **Saved online** before switching browsers;
the URL contains the private vault key. See [cloud saves](CLOUD_SAVES.md).
`session_close({sessionId})` releases the engine while retaining its journal and
standing decision; it is not in-game quit. Return through the bookmark or
`session_resume({sessionId})` on the same origin/profile and pinned runtime.

An instruction for an agent:

> Open https://neohack.dev and discover WebMCP. Use the selected adventure or
> create one run. Keep its short session token, choose from perceived information,
> answer questions explicitly and stop on uncertainty or game over. Never infer
> hidden map cells or item identity, or repeat an action after a lost reply.

For CLI setup, see the [agent-browser command reference](https://agent-browser.dev/commands).
For adapter guarantees, see [WebMCP](WEBMCP.md); for local development, use the
[web client setup](../../../web/neohack.dev/README.md#run-locally) and replace the
live origin in these examples. Local and live saves are separate.

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
