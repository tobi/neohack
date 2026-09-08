# How an agent plays

Create or resume a run, look at what the hero perceives, attempt one named action,
and handle any question it returns. The engine reports what actually happened.

Use the [source setup](QUICKSTART.md) for Node, or the
[live WebMCP walkthrough](AGENT_BROWSER.md) to play at neohack.dev.
The library is a source-build alpha, not an assumed public npm release.

```ts
import Nethack from 'neonethack';

const nethack = new Nethack();
try {
  const game = await nethack.create({ role: 'valkyrie', seed: 42 });
  console.log('Keep this run token:', game.id);
  console.log(game.observation);

  const offers = await game.actions({ direction: 'south' });
  console.log(offers.cell); // perceived attempt, not a promise of safety
  const { x, y } = game.observation.you;
  const result = await game.go({ to: { x, y: y + 1 } });
  console.log(result.reason, result.turnsElapsed);
  if (game.decision) console.log('Answer this question:', game.decision);

  await game.close(); // retain the run, including an unanswered question
} finally {
  await nethack.close();
}
```

These eight operations cover the basic interaction:

| Intent | Typed client | MCP / WebMCP tool |
| --- | --- | --- |
| Begin | `nethack.create(options)` | `session_create` |
| Return to a saved run | `nethack.resume(token)` | `session_resume` |
| Look again, for free | `game.observe()` | `session_observe` |
| Inspect nearby attempts | `game.actions(target)` | `session_actions` |
| Navigate one bounded leg | `game.go({to: {x, y}})` | `go` |
| Answer a question | `game.answer(id, answer)` | `decision_answer` |
| Cancel a cancellable question | `game.cancel(id)` | `decision_cancel` |
| Release the engine and retain the run | `game.close()` | `session_close` |

Keep the short `sessionId` returned by creation. The low protocol also requires a
unique `requestId` and the last observed revision for input; the typed client
manages these. A stale revision means look again and reconsider.

MCP and WebMCP expose navigation: pass the session token without request,
revision or decision IDs. Use `go({sessionId,to:{x,y}})` for a bounded navigation
leg, `attack({sessionId,target})` for a deliberate adjacent attack, and `help` for
brief discovery or one tool's schema. `force:true` on `go` attempts an adjacent
ordinary move; it does not force an attack or bypass an engine question. Results
include a witnessed summary and a self-contained perceived observation. Compact results label the omitted neighborhood attempts and clear-grid events; use free `session_observe` for the full current frame and `receipt` for the full input events. `retry` recovers the adapter's retained uncertain input or its most recent
completed input receipt; it never restarts a navigation leg. `receipt` reads a specified historical
`operationId` without rewinding current state. Never submit a new action to
replace a lost response. Native stdio/HTTP expose this vocabulary without a
profile flag. The low library, C API and NDJSON retain precise operations.

A decision is part of the action: select one of its actual item references,
answer its confirmation, or supply its requested text/target. MCP accepts returned readable choice names or numeric IDs; ambiguous names
return candidates without answering. The low API retains numeric choice IDs. Opening a selection
menu need not spend a turn; finishing an action can spend several. Trust
`turnsElapsed` and terminal outcomes rather than counting calls.

For navigation, `game.route({x,y})` computes a shortest known walking path from
perceived memory. A null distance means this policy knows no path. The query
avoids closed doors, creatures, boulders, known hazards and uncertain squeezes;
it does not walk or declare a route safe. `game.go({to:{x,y}})` executes a bounded
leg using that planner and re-evaluates after each actual action. It stops for
decisions, interruptions and changed circumstances. `game.go({to,force:true})`
is restricted to one adjacent ordinary movement attempt.

Other named operations cover inventory, doors, spells, searching and more.
For longer exploration, explicitly request `explore({sessionId,maxActions:80,
maxFrontiers:20})`. The default still targets one frontier. The total action
budget, genuine decisions, interruptions, damage, condition or hunger changes, and newly perceived creatures
bound the whole call; a door attempt always stops it. Read `navigation` for
aggregate progress. On a later-substep error, confirmed progress remains in the
response; an uncertain input requires exact recovery, not repeating the leg.
Use generated discovery instead of copying a fixed tool list. Read
[command coverage](COMMAND_COVERAGE.md) for demonstrated limits and
[the protocol contract](PROTOCOL.md) for exact shapes, costs and decisions.
[Hero and scripts](HERO.md) explain the event-driven higher-level library.

Use `game.lookup(name)` or MCP `session_lookup({sessionId,name})` for the pinned
game encyclopedia. Results are labelled lore, not observations or guarantees
about a nearby creature. The query spends no turns and leaves questions open.

For a fixed-seed public-API reference, see the
[exploration benchmark](../../../examples/benchmark/README.md). It records exact
runtime/policy identities and distinguishes a policy stop from an engine death.
The CLI model's adaptive retrospective loop is a separate experiment.
