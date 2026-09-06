# Attempts, consequences and recovery

**An accepted request is an attempt, not a promise of success.** Inspect the full
response and the current input gate. Preserve the engine's narration, actual
elapsed turns and terminal facts. An error flag, intended route, position change
or transport status alone cannot tell a client what happened.

The [reference client](AGENT_BROWSER.md#manual-reference-consumer) demonstrates explicit manual choices,
independent `decision.id` values, observed attempt memory and stopping on uncertain
input. [Browser creation recovery](AGENT_BROWSER.md#creation-timeout-checklist)
is separate: `session.create` has no gameplay request-ID retry contract.

## Outcome-handling matrix

These are the actual `outcome.status` values. Terminal state is a separate
`ended` / `end` fact, not an additional outcome status. Always display it even
when the last action says `completed` or `blocked`.

| Returned fact | Meaning and time | Next explicit choice |
| --- | --- | --- |
| `completed` | The operation reached its boundary. Read `effects`, `positionChanged`, events and `turnsElapsed`; completion does not mean the caller achieved its plan. | Render the current frame; choose again only at a ready gate with no unresolved request or storage diagnostic. |
| `blocked` | A gameplay attempt or protocol rejection failed. It may cost zero **or positive** turns and may have an `error`. `reason` is not a hidden-state oracle. | Inspect the witnessed result. Refresh stale references as appropriate, then replan; never permanently turn a failed move into a wall. |
| `needsChoice` | A standing typed decision requires an answer. Costs may already have occurred before the prompt. | Answer its actual `decision.id` using `decision.answer`'s `decisionId`, or explicitly cancel if cancellable. Do not repeat the initiating action. |
| `cancelled` | Explicit cancellation settled the operation. Cancellation does not undo earlier costs and is not blanket consent or a policy for later prompts. | Render, inspect the gate and replan. `confirm:false` is an answer, not a synonym for `decision.cancel`. |
| `interrupted` | An activity stopped at a real input boundary. Completed work and spent turns remain. | Inspect remaining perceived items and events. Continuing a meal, study or engraving requires a deliberate new named action; observe/retry/resume never continues it automatically. |
| `unknown` | Execution is unresolved. Even a plausible observation cannot establish that the request is safe to execute again. | Stop new input. Retain the exact immutable request and use the documented receipt/recovery path. |
| `ended:true` and `end` | The engine established a terminal result. Zero HP, process exit and missing output are not substitutes. | Stop gameplay; retain the end result. Observing or closing must not invent a new life. |
| Unknown status/decision kind, unavailable gate, missing required frame facts | The consumer cannot safely interpret the boundary. | Stop for a capable client or diagnosis; never invent a default answer. |

Before the action-specific rows, check unresolved input, `storage`/`recording`
diagnostics and `requiresResume`. Recovery instructions take priority over a
choice recorded in an old receipt. `inputGate.state` can be `ready`, `decision`,
`recoveryRequired`, `ended` or `unavailable`. A historical receipt is evidence of
its operation; it is not proof that today's gate is ready.

## What a witnessed failure establishes

- A heavy pickup can return no protocol error, `blocked/notPossible` and one
  spent turn. The item remains underfoot. Checking only `isError` repeats a
  real failed attempt and can spend more turns.
- `movement.intent:possiblePush` describes a possible boulder interaction.
  `movement.relation` describes geometry. Neither guarantees a push. A `moved`
  effect alone is insufficient; compare the perceived boulder locations and
  the engine's messages after the attempt. No unseen destination is disclosed.
- `knownRestriction:intactDoorDiagonal` is a disclosed restriction, not a
  finding about undiscovered walls. `walkable` describes terrain, independently
  of occupants and permission to issue input.
- A door's resistance and lock facts can be earned by an actual attempt.
  `doorWitness` already reports `locked`, `unlocked`, `opened`, `closed`,
  `resisted` and `notClosed`, with coordinate, level and turn. Its freshness
  distinguishes the current witnessed fact from memory. Before disclosure, a
  lock remains unknown; do not add a preflight lock or curse test.
- `game.wait` can return `blocked/noProgress` with zero elapsed turns near
  perceived danger. It is not forced rest and does not restart an interrupted
  activity. This review retains that behavior. A separate deliberate-rest
  operation would need its own explicit contract and engine tests before it
  could be advertised; repeated free probes must not reveal unseen threats.

Generic `notPossible` and `noProgress` intentionally leave causes unclassified
when no stronger public fact is supported. Do not parse prose to infer hidden
monsters, traps, secret doors, curses or a safe route. A movement request can
attack, and a resulting involuntary interval can consume many engine turns.
No intermediate input window is implied by a long `turnsElapsed`.

## Transport and receipt handling

| Situation | Required handling |
| --- | --- |
| CLI/tool envelope succeeded, inner invocation timed out | Transport completion is not an engine response. Resolve the invocation and inspect the inner result. |
| Transport throws after an input request | Keep the original request ID **and payload**, including revision, target and answer. `Game.pendingRequest` / `UncertainExecution.request` retain it. No new input ID. |
| Exact receipt is recovered | Report the returned receipt, retain any newer local observation, then observe current state before replanning. Retrieval does not rewind time or repeat the deed. |
| `incompleteRequest`, `unknown`, failed storage or recording diagnostic | Missing or damaged evidence is uncertainty. Stop input; follow explicit resume/recovery requirements with the same package and store. Never truncate, repair or silently replay on a newer engine. |
| Authoritative pre-reservation `staleRevision` rejection | The request did not reserve a receipt. Observe current state and deliberately replan with a current revision. A request ID alone does not prove a durable reservation. |
| Authoritative `staleReference` rejection | Use the current disclosed item/decision identity and a single writer to diagnose. Do not substitute a label/slot/menu neighbor or repeatedly submit the obsolete item. Whether a receipt exists follows the reservation contract, not the error name. |
| Creation response lost | Recover the detached invocation or discover the session through its owning page/store. Empty discovery during startup proves nothing. Never apply `Game.retry()` semantics to a second `session.create`. |

`Game.retry()` sends only the retained request; it does not choose a new action.
A known receipt is looked up before a stale revision is rejected. Conversely,
pre-reservation rejections may be evaluated again on an explicit caller retry.
Thus even “retry the same ID” is not a blanket claim that every response was
already durably recorded. See [the protocol](PROTOCOL.md#revisions-retries-and-storage).

## A minimal explicit caller

This handler executes exactly the search the caller selected. It presents the
current frame, including errors and uncertainty, and returns control to the
caller. It never loops, answers a warning or retries on its own.

```js
import { UncertainExecution, WorldError } from 'neonethack';

export async function chosenSearch(game, render, report) {
  try {
    const receipt = await game.search();
    report({ kind: 'receipt', receipt });
  } catch (error) {
    if (error instanceof UncertainExecution) {
      report({ kind: 'uncertain', request: error.request });
    } else if (error instanceof WorldError) {
      report({ kind: 'rejected', response: error.response });
    } else {
      throw error;
    }
  } finally {
    // Current state never regresses to an older recovered receipt.
    render({ frame: game.state, pendingRequest: game.pendingRequest });
  }
}
```

The application must render a stop/recovery state whenever `pendingRequest`,
unknown outcome or diagnostics require it. Only an explicit recovery command
should call `game.retry()`. After a validated result and current observation,
the player chooses a new action. The complete reference consumer additionally
checks gates, terminal facts, decision identity and movement oscillation.

## Evidence and test scope

Fresh controlled native engine scenarios in `tests/attempt-outcomes.test.mjs`
place a boulder in a new temporary world to test heavy pickup and an actual
push, including costs, observed displacement and exact receipts. The test engine
is compiled in a temporary directory; the production engine and existing saves
are never modified. The fixture setup is not a public capability or a replay of
the overnight life. The same test module also covers stale revisions/references,
terminal rejections and input immutability through ordinary public operations.

Existing shared native/WASM scenarios in `affordance-contracts.mjs`,
`gameplay-contracts.mjs` and `interruption-contracts.mjs` cover locked/resistant
doors, intact-door diagonals, stale item selection, interrupted activities,
guarded wait, explicit choices and receipt replay. Transport-loss and storage
fault scenarios remain separate from successful gameplay attempts. The overnight
stale-reference root cause remains unproven; new tests must not claim to repair
an unarchived historical request.
