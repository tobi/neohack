# How an agent plays

Create a run, read the perceived scene, attempt a named action, and answer any
question explicitly. Native stdio MCP, HTTP MCP and browser WebMCP use the same
vocabulary. Keep the short `sessionId`; the adapter owns request IDs and revisions.

| Intent | MCP / WebMCP call |
| --- | --- |
| Begin once | `create({role:"valkyrie"})` |
| Return to a saved run | `resume({sessionId})` |
| Walk a leg toward a destination | `go({sessionId,to:{x:40,y:10}})` |
| Reveal the next frontiers | `explore({sessionId,maxFrontiers:4})` |
| Resynchronize with the full JSON scene, free | `syncState({sessionId})` |
| Inspect attempts at one square, free | `inspect({sessionId,target:"here"})` |
| Answer the standing question | `answer({sessionId,decisionId,value})` |
| Cancel its current action | `cancel({sessionId,decisionId})` |
| Release the saved run | `suspend({sessionId})` |

`help({})` lists every tool; `help({name:"eat"})` gives one schema. Specialist
commands remain available: spells, equipment, offerings, engraving, native
running and more. No profile switch or raw-key escape hatch is needed.

Use an exact returned item reference: `eat({sessionId,itemId:"item-42"})`.
The example ID is a placeholder; copy yours from inventory or the floor view.
`drop` also accepts `quantity`. Omit `itemId` to ask the engine for a selection.
Readable names are not item IDs. `inspect` returns `attempts` with tool/argument
syntax and, when the square can be resolved, `mark` for the character NetHack
displays there; eligibility does not guarantee safety or success.

Every reply is a complete view for the next decision: `state` (position, level
and vitals), fresh `messages`, a text `map` of the perceived level, `creatures`
with target IDs, and `context` from free perceived-state queries. `map.text`
draws the known part of the level with x labels and ticks every five columns and
each row's y in front; `map.legend` names what every mark on this map stands
for, built from the same terrain, object and creature layers the JSON exposes.
MCP also returns the map in a separate fenced text block with real newlines;
the first text block and `structuredContent` retain the complete JSON reply.
`map.positions` indexes displayed occupants, objects and terrain features by
mark, with exact `{x,y}` coordinates for every match. Plain floor, corridor
and wall cells are omitted from this index. For example, `map.positions['+']`
locates displayed closed doors without counting columns in JSON-escaped text.
Duplicate marks list all matches; the index never selects one for you.
Use a chosen coordinate with `attack({target:{x,y}})` or `go({to:{x,y}})`;
`kick` takes `target:{direction:...}` from the adjacent context or inspect offer.
`mark` is the character NetHack displays for that square; `map.text` is those
marks laid out with rulers. JSON entities on the map (`creatures[]`,
`context.nearby.cells` when the square is in the known world,
`context.frontiers`, `context.doors`, `context.waysDown`, and inspect) carry
the same `mark`. Marks are display, not identity or a hidden item.
`context.nearby` gives one line per adjacent square: terrain, movement intent,
occupant, hazards and which tools the resolver offers there (`go` means
`go({direction})`); known frontiers, doors and downward stairs follow.
You do not need a syncState–inspect–navigation ritual after an action; the
ordinary reply already omits the JSON `observation.world`, `heard` and
`knowledge` in favour of the map (see `presentation.omitted`). `syncState`
returns them when you actually need cell-level facts or lost your context.
`context.status: unavailable` affects enrichment only; the action's outcome and
receipt remain authoritative. Message turns identify the response boundary, not
individual internal turns of a counted action. `syncState` carries no fresh
messages, so it omits the `messages` field; the JSON `observation.heard` it
returns is recent history and may repeat.

Move in legs rather than single steps. `go({to})` walks any known route in one
call, `explore` walks to the next frontier (`maxFrontiers` for several) and
`descend` approaches known stairs; each leg stops for a question, damage,
hunger, a new creature or a blocked step and reports why in `navigation`. One
leg replaces many step-and-read exchanges.

A question arrives as `decision`, accompanied by `reply.arguments` and
`reply.valueSchema`. Copy those bound arguments and supply your chosen `value`:

| Question | Example value |
| --- | --- |
| Confirmation | `false` to decline, `true` to accept |
| Text | `"My potion nickname"` |
| Item | `{itemId:"item-42"}` |
| Choice | An array of returned option names or numeric IDs |
| Target | `"north"` or `"self"` |
| Position | `{x:40,y:10}`, a compass direction, `"help"` or `"finish"` |

Never reuse an old `decisionId`. Answering may produce another question.
Cancellation can spend turns or resources: the actual outcome, `turnsElapsed`
and terminal facts outrank your intention.

`explore({sessionId,maxActions:8})` explores a bounded leg; `descend` approaches
known downward stairs. Both stop on changed circumstances or questions. `go`
uses perceived routes and swaps places with a displayed tame ally standing on
them, as ordinary movement does; hostile or peaceful occupants are never routed
through. `go({direction})` attempts one adjacent ordinary step;
deliberate force attack is the separate `attack` tool.
If there is no knownWalking path, `navigation.reason` is `noRoute` and `why` is
`targetOccupied`, `targetUnknown`, `closedDoor` or `disconnected`, with a `hint`
for the next explicit tool. Zero-action stops did not run input. Confirmed partial
legs need no recovery ritual: read the returned scene and choose what to do next.

`navigation.stop.kind` identifies a witnessed health, hunger, condition, level,
creature or position change. An occupied square does not imply a hostile creature.
Rejected arguments marked `inputSubmitted:false` include the schema or current
context needed to correct them; they need no recovery.

After an uncertain error or lost response, call `syncState({sessionId})`. It checks any retained
uncertain receipt without resending input, then returns the current scene and
standing question. If the receipt cannot be verified, stop and follow the explicit
resume instruction. Never repeat an action or navigation leg blindly. `receipt`
is a diagnostic historical document nested under `receipt`; it is not your current
position. There is no `recover` tool. A completely lost outer reply may require
the bridge's invocation ID to identify the exact operation.

Start with the [live browser walkthrough](AGENT_BROWSER.md) or
[native/typed-library setup](QUICKSTART.md). The typed library retains precise
methods and tagged answers; see [Hero](HERO.md) and [TypeScript](TYPESCRIPT.md).
The [contract](PROTOCOL.md), [navigation and recovery](WEBMCP.md),
[command coverage](COMMAND_COVERAGE.md) and
[fixed-seed benchmark](../../../examples/benchmark/README.md) describe guarantees
and demonstrated limits. No ascension ability is implied by tool coverage.
