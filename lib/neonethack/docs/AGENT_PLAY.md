# How an agent plays

MCP and WebMCP expose eleven intention families, not one tool per engine command.
The native/low API remains unchanged. Check the running build's help schemas;
source documentation does not establish what production has deployed.

| Tool | Intent |
| --- | --- |
| `session` | Explicit create, resume, suspend or quit |
| `observe` | Current full scene/recovery, or an exact historical operationId |
| `interact` | Free square discovery; explicit spatial actions, payment, prayer, skills, search/rest |
| `use` | Free item discovery; explicit item use, firing, casting or engraving |
| `travel` | Explicit step, run, climb, destination, exploration or descent mode |
| `equipment` | Wield, wear, remove, quiver, swap or twoWeapon |
| `inventory` | Pickup, drop or configurePickup |
| `plan` | Free frontiers or route query |
| `lookup` | Pinned encyclopedia |
| `respond` | Exact decision answer or permitted cancellation |
| `help` | Family descriptions and strict variant schemas |

## Discover without acting

Omitting `action` on `use` or `interact` is always free discovery, even if
there is only one possible offer. Supplying `action` requests execution.
Discovery consumes no engine input, turns or randomness, and never starts or
answers an engine decision. Item candidates come from C's perceived actions,
not labels, inventory letters, guessed powers or default verbs.

```js
use({sessionId, itemId: "RETURNED_ITEM_ID"})
interact({sessionId, target: {symbol: "+", scope: "adjacent"}})
interact({sessionId}) // here/self
```

Results contain executable offers bound to the returned `basis.viewId`.
An item offer may point to `equipment` or `inventory`, not only `use`.
Unavailable/stale perception is explicit, not an empty list of possibilities.
Supported general commands are labelled separately from perceived eligibility;
an available operation is never a safety or success prediction.

If a symbol has zero or multiple matches, no input is sent. Multiple matches
return perceived candidates; choose a coordinate/reference explicitly. Allies
still count. Spatial selectors are `{direction}`, `{position:{x,y}}`, `{ref}`
or `{symbol,scope:'adjacent'|'level'}`, within each variant's declared subset.
Ranged use accepts directions only, including permitted self/up/down.
References bind a perceived square, not a persistent hidden creature identity.

## Execute an explicit intention

Keep `basis.sessionId` and `basis.viewId` from the received frame. Mutations
require that exact view except session create/resume/suspend and exact
`respond` calls. Stale views reject without refreshing or retargeting input.
Strict variants reject unrelated fields rather than silently ignoring them.

A gameplay call that ends in death returns MCP `isError: true`, with the actual
cause in `scene.end`. Its input was still accepted: retain the outcome and exact
receipt; do not retry it. Further gameplay rejects without input. Postmortem
observation, receipt reads and session cleanup remain available.

```js
session({action: "create", role: "valkyrie"})
travel({sessionId, viewId, mode: "step", target: {direction: "east"}})
travel({sessionId, viewId, mode: "to", to: {x: 40, y: 10}})
travel({sessionId, viewId, mode: "explore", maxActions: 8})
use({sessionId, viewId, action: "drink", itemId: "RETURNED_ITEM_ID"})
interact({sessionId, viewId, action: "open", target: {direction: "east"}})
equipment({sessionId, viewId, action: "wear", itemId: "RETURNED_ITEM_ID"})
interact({sessionId, viewId, action: "rest", turns: 5})
session({sessionId, action: "suspend"})
```

Coordinates and IDs are syntax examples, not selected actions.
`travel mode step` retains ordinary one-step semantics and tame-ally swaps;
displayed non-allies require explicit `interact action attack`. A distant
hostile cannot impose long-leg stopping rules on an adjacent retreat attempt.
Modes to/explore/descend are bounded C-planned known-walking legs, with witnessed
progress and stop causes. maxPlanningMs defaults to 1000; zero submits no
planning query/input. maxFrontiers explicitly permits multiple exploration legs.
Run uses native direction/noPickup and optional `runMode`; climb is a direct
vertical attempt. Neither is silently replaced by destination navigation.

Explicit item actions may omit itemId to request a genuine engine selection
where supported. `use action cast` starts the actual spell decision;
perceived spell knowledge is not a decision-choice ID. `use action engrave`
retains the engine's implement (including fingers), text and warning questions.
No convenience auto-selects, auto-confirms or chains answers.

## Read the frame and answer deliberately

The [DecisionFrame](PROTOCOL.md#mcp-observation-presentation) separates basis,
control.gate, actual outcome, perceived scene, standing decision, fresh events,
query result and diagnostics. Routine scenes are complete for the next decision;
`observe` additionally includes full world. No mandatory discovery/observe loop.
Map positions and entities supply exact coordinates; do not count ASCII columns.

Copy `decision.reply.arguments` and deliberately add a value matching its
`valueSchema`. The tool is `respond`, with action answer. Permitted cancellation
supplies a separate `decision.cancel` call with action cancel. Both bind the
exact decisionId. Answers may spend turns or produce another genuine question;
cancellation is not rollback. Item IDs and decision choice IDs are distinct.

After a lost reply, `observe({sessionId})` verifies retained exact evidence
without resending gameplay. Unverified input stays blocked. A normal navigation
stop needs no recovery. `observe({sessionId,operationId})` returns historical
evidence under result, never a live scene/question to act on. Terminal facts live
in scene.end. Suspend preserves the run; explicit quit retains engine confirmation.

See [browser setup](AGENT_BROWSER.md), [local setup](QUICKSTART.md), and
[WebMCP ownership](WEBMCP.md). Tool-count reduction alone establishes neither
better survival nor fewer model mistakes.

## Catalog size measurement

On 2026-09-14, compared with commit 1487c20, JSON.stringify of the generated
tools array shrank from 325,040 to 93,932 UTF-8 bytes (53 to 11 tools).
Projecting only name, description and inputSchema shrank from 65,029 to 39,134
bytes. This excludes the JSON-RPC envelope and is not a model-token, latency or
survival measurement. Shared schema definitions reduce duplication while strict
variant branches retain field restrictions and required input authority.
