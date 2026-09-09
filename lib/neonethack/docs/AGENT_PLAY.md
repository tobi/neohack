# How an agent plays

Create a run, read the perceived scene, attempt a named action, and answer any
question explicitly. Native stdio MCP, HTTP MCP and browser WebMCP use the same
vocabulary. Keep the short `sessionId`; the adapter owns request IDs and revisions.

| Intent | MCP / WebMCP call |
| --- | --- |
| Begin once | `create({role:"valkyrie"})` |
| Return to a saved run | `resume({sessionId})` |
| Read the full scene, free | `observe({sessionId})` |
| Inspect nearby attempts, free | `inspect({sessionId,target:"here"})` |
| Walk toward a destination | `go({sessionId,to:{x:40,y:10},maxActions:8})` |
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
syntax; eligibility does not guarantee safety or success.

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
uses perceived routes. Its `force:true` option attempts only adjacent ordinary
movement; deliberate force attack is the separate `attack` tool.
If there is no knownWalking path, `navigation.reason` is `noRoute` and `why` is
`targetOccupied`, `targetUnknown`, `closedDoor` or `disconnected`, with a `hint`
for the next explicit tool. Zero-action stops did not run input. After a partial
leg, `recover` and `lastOperationId` mean call recover; do not resubmit the leg.

After an uncertain response, use `recover({sessionId})` for the retained exact
input or `receipt({sessionId,operationId})` for a known historical result. Never
repeat a new action blindly. Recovery is shared per run: a completely lost reply
followed by another participant's input may leave the earlier operation ID
unavailable. Historical receipts are not current observations.

Start with the [live browser walkthrough](AGENT_BROWSER.md) or
[native/typed-library setup](QUICKSTART.md). The typed library retains precise
methods and tagged answers; see [Hero](HERO.md) and [TypeScript](TYPESCRIPT.md).
The [contract](PROTOCOL.md), [navigation and recovery](WEBMCP.md),
[command coverage](COMMAND_COVERAGE.md) and
[fixed-seed benchmark](../../../examples/benchmark/README.md) describe guarantees
and demonstrated limits. No ascension ability is implied by tool coverage.
