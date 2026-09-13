# How an agent plays

Create a run, read its DecisionFrame, attempt a named action and answer any
standing question explicitly. This guide describes the MCP redesign target being
implemented across Bun/WASM stdio, HTTP and browser WebMCP. Check a build's
`help` schemas before using it; this is not a claim that production has deployed
the redesign. Native/low semantics remain unchanged.

Keep `basis.sessionId` and `basis.viewId` from the returned frame. Gameplay calls
against that live view require both; `answer` and `cancel` instead require the
exact `decision.id`. The adapter owns engine request IDs and revision plumbing,
but cannot silently substitute a newer view for the one you acted on. Lifecycle
calls (`create`, `resume`, `suspend`) do not require a prior gameplay view.

| Intent | MCP / WebMCP call |
| --- | --- |
| Begin once | `create({role:"valkyrie"})` |
| Return to a saved run | `resume({sessionId})` |
| Attempt one adjacent step | `step({sessionId,viewId,target:{direction:"east"}})` |
| Walk toward a destination | `go({sessionId,viewId,to:{x:40,y:10}})` |
| Explore a bounded leg | `explore({sessionId,viewId,maxActions:8})` |
| Resynchronize with the full perceived scene, free | `syncState({sessionId})` |
| Inspect here, free | `inspect({sessionId,target:{direction:"self"}})` |
| Answer the standing question | `answer({sessionId,decisionId,value})` |
| Cancel its current action when permitted | `cancel({sessionId,decisionId})` |
| Release the saved run | `suspend({sessionId})` |

Coordinates and IDs above are examples, not selected actions. `help({})` lists
tools; `help({name:"eat"})` gives one schema. Specialist named commands remain
discoverable. No profile switch or raw-key escape hatch is needed.

## Read one frame

The [DecisionFrame contract](PROTOCOL.md#mcp-observation-presentation) separates
`control.gate`, actual `outcome`, current `scene`, standing `decision`, fresh
`events` and query `result`. Read the gate before attempting more input. A query
may have no action outcome; unavailable basis or scene is explicitly null.
Terminal details live in `scene.end`; the input gate still governs further input.
Never infer execution from elapsed turns or position alone.

Routine replies are self-contained scene snapshots for the next decision:
`scene.self`, `nearby`, `entities`, `features`, `map`, `inventory`, `here`,
`automaticPickup` and `perception`. Full `scene.world` is supplied by `syncState`
when cell layers or resynchronization are needed. Do not add a sync/inspect/route
ritual after every action. Unavailable knowledge is not an empty floor or bag.

`scene.map.text` is a perceived visual summary with coordinate rulers and a
legend. Its symbol-position index retains duplicate matches. Use structured
nearby/entity/feature positions for targets; do not count ASCII columns or infer
terrain under an object from its glyph. The map never identifies hidden creatures,
items or safety. Read-only sync does not turn rolling narration into fresh events.

## Choose a target

Tools accept declared subsets of one target grammar:

| Selector | Example |
| --- | --- |
| Direction | `{target:{direction:"east"}}` |
| Coordinate | `{target:{position:{x:31,y:15}}}` |
| Perceived reference | `{target:{ref:"RETURNED_REF"}}` |
| Display symbol in explicit scope | `{target:{symbol:"g",scope:"adjacent"}}` |
| Here/self, where permitted | `{target:{direction:"self"}}` |

`scope` is `adjacent` or `level`, within the tool's spatial restrictions.
An absent or ambiguous symbol match submits no input; select from the disclosed
candidates explicitly. An ally with the same symbol still counts. References
belong to their perceived view, not a persistent hidden creature identity.

Item actions use opaque IDs, for example
`eat({sessionId,viewId,itemId:"RETURNED_ITEM_ID"})`. Omit `itemId` to ask for an
engine selection where supported. Names, inventory letters and decision choice
IDs are not substitutes for an item ID. Inspect offers supply executable syntax
for attempts, without promising safety or success.

## Move and answer deliberately

`step` makes one ordinary adjacent attempt, preserving tame-ally swaps and real
warnings. It does not automatically fight a displayed non-ally. `attack` is a
separate deliberate action. A visible hostile elsewhere must not cause a
long-leg stop policy to suppress a requested adjacent retreat attempt.

`go` accepts a destination only. `explore` selects perceived frontiers and
`descend` approaches known downward stairs. These are bounded legs over shared
C planning, with progress and witnessed stop causes. They do not route through
unknown terrain as though it were known floor, answer warnings or automatically
continue after a stop. Normal confirmed partial progress needs no recovery call.

A standing question contains `decision.reply.arguments` and
`decision.reply.valueSchema`, plus `decision.cancel` when permitted. Copy the
bound arguments and deliberately supply `value` matching that exact schema.
Confirmations take booleans; item selections use opaque item IDs; choices use
the returned option names/IDs and cardinality; text and direction questions use
their contextual value shapes. Decision answer syntax is separate from the
operation target grammar. Answering may produce another question with a new ID.
Cancellation may spend turns or resources and is not rollback.

## Uncertain execution

After uncertain execution or a lost response, call `syncState({sessionId})`.
It checks any retained exact receipt without resending gameplay, then returns
the current scene and question. If verification is unavailable, keep input
blocked and follow the recovery instruction. Do not repeat the action or leg.
Rejected arguments that submitted no input need correction, not receipt recovery.

`receipt` is diagnostic historical query data, not current position or an active
question. Never execute answer syntax from an old receipt. There is no MCP
`recover` tool. Retain bridge invocation IDs: a completely lost outer response
may otherwise leave the exact operation unknown.

Start with the [browser walkthrough](AGENT_BROWSER.md) or
[local setup](QUICKSTART.md). The [WebMCP guide](WEBMCP.md) covers shared browser
input and ownership. [Hero](HERO.md) and [TypeScript](TYPESCRIPT.md) document the
distinct typed APIs; [command coverage](COMMAND_COVERAGE.md) records demonstrated
limits. Tool coverage does not establish ascension ability.
