# Explorer API design

**Status: target contract, not a claim that the current API implements it.**

The API exposes a game, not a terminal with renamed prompts. The caller is an
explorer who moves, examines things, eats, equips items, and chooses targets.
NetHack's keyboard commands, inventory letters, modal prompts, and display
pauses are implementation details handled before the public API boundary.

The interface must be obvious enough that a client can play correctly without
knowing NetHack's terminal conventions. It must not play strategically for the
client or reveal information the explorer could not perceive.

## 1. Non-negotiable properties

1. **One request expresses one intent.** `kick south` includes selecting kick and
   answering which direction. It does not expose those as separate client steps.
2. **Every action returns a usable observation.** The client must not call
   `get_state` after every move to discover where it is or whether it was hurt.
3. **Self, here, direction, and waiting are distinct concepts.** Targeting oneself
   is not an undocumented spelling of a direction or a no-op.
4. **Selections refer to things, not terminal slots.** Names and opaque references
   identify perceived objects. Inventory letters and menu ordinals stay private.
5. **Real choices remain real choices.** Ambiguities, game warnings, and meaningful
   confirmations stop execution and return a typed decision.
6. **Narration explains; structured data controls.** A client should not need to
   parse “This door is locked” or “What do you want to eat? [a-j or ?*]”.
7. **No hidden-state advantage.** Available information is limited to the
   explorer's perception, remembered observations, and known belongings.
8. **No silent repetition.** Retries, stale responses, and multi-step commands
   cannot accidentally consume another item, pray again, or move twice.

## 2. Public tools

Keep a small tool surface and a strict, discriminated action schema:

| Tool | Purpose |
|---|---|
| `new_game` | Start with named identity fields and an optional deterministic seed. |
| `get_state` | Read the current observation; never consume a turn. |
| `act` | Execute a named action or continue a pending decision. |
| `resume` | Re-enter a session with its observation and pending operation intact. |
| `end_session` | Leave the session with a documented persistence outcome. |

Use words for roles, races, gender, and alignment. Advertise the schema version,
capabilities, and supported actions. Unknown action names are errors, not a
fallback to typing characters into the engine.

Examples below omit `sessionId`, `requestId`, and `expectedRevision` for brevity.
Those fields are specified in section 8.

### Named actions

```json
{"action":"move","direction":"north"}
{"action":"wait"}
{"action":"climb","direction":"down"}
{"action":"inspect","target":"self"}
{"action":"inspect","target":"here"}
{"action":"inventory"}
{"action":"search","target":"here"}
{"action":"kick","target":{"direction":"south"}}
{"action":"eat","item":"food ration"}
{"action":"drink","item":"potion of healing"}
{"action":"equip","item":"iron helmet"}
{"action":"wield","item":"spear"}
{"action":"read","item":"scroll labeled ZELGO MER"}
{"action":"zap","item":"wand of healing","target":"self"}
{"action":"pray"}
```

Provide equivalent semantic support for pickup, drop, remove equipment, apply,
cast, open, close, unlock, engrave, and other supported game actions. Do not
claim support until the entire action flow works.

`move` means a single attempted step. Normal NetHack bump behavior may open a
door, exchange places with an ally, or attack a creature; report the actual
effect. Explicit `attack`, `open`, and `swap` actions can avoid that ambiguity.
Never silently force an attack on a peaceful creature.

`equip` selects the known appropriate equipment slot. It does not automatically
remove other equipment, discard a weapon, or choose between conflicting items.
Return a decision when a meaningful replacement is needed.

No action automatically walks across the map to reach an item. Navigation or
travel, if offered, must be a separately named, bounded action with explicit
interruption rules. Waiting/searching repeatedly must likewise require an
explicit bound; the server must not retry until success.

## 3. Targets: make acting on yourself obvious

Use the same target vocabulary across actions, constrained by each action's
schema:

| Target | Meaning |
|---|---|
| `"self"` | The explorer, wherever currently standing. |
| `"here"` | The explorer's current square and its perceived contents. |
| `{"direction":"south"}` | An adjacent direction or directional aim, depending on the action. |
| `{"entity":"creature-7"}` | A currently valid perceived entity reference. |
| `{"position":{"x":18,"y":5}}` | A location in the current perceived level, for actions that accept positions. |

A self-directed wand must explicitly accept `target: "self"`. Inspecting self
returns known conditions and equipment; inspecting here returns the known
terrain and objects underfoot. Waiting is `action: "wait"`, never a target.

Up/down **aiming** is distinct from climbing stairs. Invalid target kinds are
rejected before engine input. Do not turn an invalid target into a wait or an
arbitrary direction. Do not permit self-targeting actions merely because their
terminal implementation happens to accept a particular character.

## 4. Items: lists first, fuzzy matching as a convenience

An action without an item should expose the appropriate candidates:

```json
{"action":"eat"}
```

Example decision, returned alongside the normal observation:

```json
{
  "id":"decision-17",
  "kind":"item",
  "action":"eat",
  "selection":{"min":1,"max":1},
  "cancellable":true,
  "options":[
    {"id":"item-17","label":"food ration","location":"inventory","quantity":2},
    {"id":"ground-3","label":"lichen corpse","location":"here","quantity":1}
  ]
}
```

The client can select explicitly or start a later action with a reference:

```json
{"replyTo":"decision-17","item":{"id":"item-17"}}
{"action":"eat","item":{"id":"item-17"}}
{"action":"eat","item":"ration"}
```

### Matching rules

- Resolve against currently known, applicable candidates, not the engine's
  complete hidden object database.
- Exact references take precedence. Names are matched deterministically using
  normalization, aliases, and conservative fuzzy matching.
- A unique, confident match can execute. State which item was resolved.
- Multiple plausible matches return candidates. Never silently select the first
  ration, wand, ring, or corpse.
- A miss returns `noMatch` and useful candidates without spending a turn.
- No candidates returns `unavailable` with an explanation. Do not repeatedly
  invoke an engine action that cannot select anything.
- References are opaque, session-scoped handles, not engine pointers. Validate
  their continued existence, location, and revision. Stale references must not
  silently bind to a newly reused inventory letter.
- Allow explicit quantities for actions such as pickup/drop. Eating one item
  from a stack does not mean consuming the whole stack.

Listing/resolving candidates does not consume a game turn. Do not secretly run
an in-game inspection that spends time to populate a supposedly free query.

**Eligible is not safe.** An edible corpse may be dangerous. Preserve actual
game warnings; expose known hazards only. Do not reveal hidden poison, corpse
age, curse state, enchantment, or unidentified properties. Candidate filtering
must not become an oracle for those properties. When eligibility itself is
unknown, preserve that uncertainty rather than revealing it through omission.

`here` includes only perceived objects underfoot, not every corpse visible in
the dungeon. Reaching a distant item requires a separate move/travel action.

Use this same discovery and resolution pattern for drink, read, wield, equip,
apply, zap, pickup, and drop.

## 5. Typed decisions, not terminal prompts

Expose decisions only when the explorer must choose something. The public kinds
are semantic: `item`, `target`, `confirmation`, `choice`, and `text`.

Example targeting decision:

```json
{
  "id":"decision-18",
  "kind":"target",
  "action":"zap",
  "allowedTargets":["self","direction"],
  "cancellable":true,
  "about":"Where do you want to aim?"
}
```

```json
{"replyTo":"decision-18","target":"self"}
```

Other answers use explicit fields such as `confirm: false`, `choose: ["id"]`,
`text: "a new name"`, or `cancel: true`. Choice options have opaque identifiers,
labels, and selection limits. Headers are not selectable options.

- Reserve `text` for actual words, such as naming or engraving. It must not mean
  “speak an inventory letter” or “type the first character of a direction”.
- Boolean confirmations are booleans, not options named `y` and `n`.
- A direction remains a direction regardless of which internal input callback
  NetHack used to ask for it.
- Include cancellation support and the suspended action in every decision.
- Responding to a decision continues that operation exactly once. It does not
  start the initiating action again.
- Reject an incorrect answer shape or stale decision ID without advancing the
  engine or changing the pending decision.

Auto-dismiss narration pauses and display-only lists, retaining their content
as events. Never auto-confirm a purchase, attack, warning, or other meaningful
choice just to make a sequence finish. On interruption, do not resume a dangerous
operation without an explicit policy or further caller intent.

## 6. Every action returns state

Return a coherent observation after **every accepted action or decision answer**,
including zero-turn actions, cancellations, interruptions, and terminal states.
Full observation is the default. Optimize to deltas only as an optional mode
once the complete contract is correct.

Example response; the observation is abbreviated here:

```json
{
  "sessionId":"session-1",
  "requestId":"request-42",
  "revision":42,
  "outcome":{
    "action":"kick",
    "status":"blocked",
    "reason":"lockedDoor",
    "turnsElapsed":1,
    "positionChanged":false,
    "effects":[]
  },
  "observation":{
    "turn":123,
    "location":{"id":"level-a","depthLabel":"2"},
    "you":{"x":56,"y":10},
    "vitals":{"health":18,"maxHealth":26,"hunger":"hungry"},
    "inventory":[],
    "world":[]
  },
  "events":[{"type":"message","text":"The door holds firm."}],
  "decision":null,
  "ended":false,
  "end":null
}
```

`outcome.reason` in this example requires previously established lock knowledge;
otherwise report only the observed failed kick. Outcomes must not disclose a
hidden lock, trap, or resistance merely because the engine knows about it.

### Observation requirements

- Always return the authoritative position, turn, vitals, and current location.
- Return known inventory and equipment, or explicitly mark them unknown/unavailable;
  an empty list means known empty, not “not fetched”.
- Use numbers for health, energy, level, armor class, gold, and experience when
  known. Use normalized enums for hunger/burden and arrays for conditions.
- Represent non-numeric strength such as `18/02` explicitly. Do not blindly cast
  every status field to a number.
- Trim display labels; do not leak `field-2`, status flush sentinels, or other
  bookkeeping as vitals.
- A stable perceived location ID distinguishes levels in different branches
  that happen to share a depth number.
- Narrative events include everything produced by this operation boundary, in
  order. A rolling recent-message list is not a substitute for action events.
- The response describes the state at the next genuine decision boundary, not
  an intermediate drawing or cursor notification.

`get_state` is observational. It must not drain another client's event stream
or discard events needed for a subsequent action response.

### Optional deltas

A delta response must still include the small authoritative self/vitals block.
Map/inventory patches declare a base revision, location, upserts, and removals.
Level changes and resume return a replacement snapshot. Clients must never
have to infer a map reset from a collection of blank glyphs. An event cursor
supports independent readers and gap detection.

The equivalence test is:

> Applying all action updates to the initial observation yields the same
> perception as an independent final `get_state`, without intervening reads.

## 7. Perception is layered and knowledge-limited

An occupant must not erase known terrain:

```json
{
  "x":18,
  "y":5,
  "terrain":{"type":"stairsDown","knowledge":"remembered"},
  "occupant":{"kind":"self"}
}
```

- Separate known terrain, perceived occupants, and perceived objects. Standing
  on stairs does not make previously observed stairs unknowable.
- If the underlying square has never been perceived, it stays unknown.
- Preserve remembered terrain without treating a remembered monster as a
  currently visible target. Expose observation freshness where available.
- Classify the explorer consistently as `self` in both snapshots and updates,
  not as an ordinary creature in one path.
- Ally/peaceful/hostile/unknown relationship is separate from creature type, and
  only as certain as the explorer can establish. Do not equate “creature” with
  “enemy”.
- Expose perceived terrain semantics such as a wall, open door, closed door,
  stairs, or water instead of requiring inference from `|`, `-`, or `}`. Marks
  and colors are optional presentation hints, not the primary game model.
- Do not reveal undiscovered traps, unseen objects, hidden monster identities,
  exact hunger counters, prayer cooldowns, or other unavailable state.

The API can explain a known locked door after a failed attempt. It cannot mark
all unseen locks beforehand. Likewise, inspect can expose known facts but must
not substitute an omniscient engine query for in-game examination.

## 8. Outcomes, revisions, and retries

Action outcome statuses are `completed`, `needsChoice`, `blocked`, `cancelled`,
`interrupted`, and `unknown`. Effects describe what actually happened, such as
`moved`, `attacked`, `openedDoor`, or `consumedItem`.

Always include turns elapsed and whether position changed. They are different:
combat, opening a door, eating, or waiting may consume time without movement;
a selection or failed attempt may consume none. A compound action may span
multiple turns. Do not classify every stationary action as a wall bump.

Every mutating request carries:

```json
{
  "sessionId":"session-1",
  "requestId":"request-42",
  "expectedRevision":41,
  "action":"eat",
  "item":{"id":"item-17"}
}
```

- Serialize operations within a session.
- The same request ID and payload return the original result rather than
  executing again. Reusing an ID with different arguments is an error.
- Check a known retry before stale-revision rejection so a timed-out successful
  action remains safely retrievable.
- Reject stale revisions/decision IDs and invalid shapes before engine writes
  or input-log appends. Return a structured error and current recovery context.
- Revision identifies an accepted interaction boundary; it is not game time.
  Read-only inspection does not mutate it. A zero-turn accepted selection may.
- Persist enough request/operation metadata for retries and pending decisions
  to remain safe across reconnects and deterministic resume.
- A timeout is not permission to resend an action as a new operation. Return an
  explicit pending/unknown execution status that the caller can recover.

## 9. Terminal results are durable

Keep the end result separate from recent narration and post-game lists:

```json
{
  "ended":true,
  "end":{"kind":"death","cause":"starvation","turn":3292}
}
```

Distinguish death, ascended, escaped, quit, disconnected, and engine error.
Only report a specific cause when supported by the engine's terminal result or
reliable observed evidence; otherwise report unknown. Fainting is a condition,
not by itself a cause of death. A process exiting proves neither death nor a win.

Disclosure screens, inventory identification, and vanquished lists must not
replace the recorded end result. Leaving a session is not automatically an
in-game quit; specify save/persistence behavior separately.

Implemented: the engine issues `game_ended` only after life saving has been
ruled out. The C core preserves its kind/cause/turn and final health, freezes the
final gameplay observation across post-mortem disclosure, and retires the engine
without inventing disclosure answers. Final action receipts remain retryable
and the final observation remains readable. Old engines without terminal facts
remain unknown; an unexpected process loss is `engineError`, never death.
Shutdown allows two seconds for graceful exit, then kills/reaps a stuck child;
the durable input journal remains the recovery source.

## 10. Adapter architecture

Build a semantic adapter, not a growing collection of English-prompt regexes.

Implemented once in C as libneonethack (`lib/explorer.c`, `lib/session.c`,
`lib/minjson.c`); `cli/`, `mcp/`, and `client/` are thin bindings that
forward to it. The rules below describe the core; bindings add no
semantics of their own.

1. **Resolve and validate intent.** Validate against advertised action schemas,
   current perception, references, request IDs, and revision.
2. **Track an operation.** Record action, supplied arguments, phase, and any
   genuine unresolved decision. Clear it on completion/cancellation.
3. **Drive NetHack privately.** Translate the intent into the engine's command
   sequence and supply only arguments the caller already authorized.
4. **Stop at the right boundary.** Consume narration and presentation pauses,
   but stop at a real choice or unexpected interruption.
5. **Assemble one response.** Preserve all action events and snapshot perception
   once at the boundary. Adding a snapshot must not accidentally drain events.

Add structured context at the headless engine boundary where generic input
callbacks are insufficient: action identity, item-selection purpose, target
mode, confirmation meaning, command completion, and terminal result. Engine
context is more robust than recognizing English questions or assuming every
unrestricted response is free text.

If an input cannot be classified, return a recoverable `unsupportedInteraction`
with diagnostic context; never choose a default direction, type a guessed
letter, or silently confirm. Raw input may remain in an explicitly separate
compatibility/debug interface, not as a requirement of normal play.

Existing low-level input logs can remain the replay mechanism. Preserve the
semantic operation/request metadata alongside them and ensure replay does not
re-run live auto-answering or resolve names differently midway through a replay.

## 11. Implementation order

Status (2026-09-04): this remains the target contract, not a blanket completion
claim. Core regressions now cover read-only food discovery, perceived item
classes, stable object refs, missing targets, conflicting retry payloads, open
doors, real pet exchange, locked doors, fatal prayer, escape consent, process
failure, bounded teardown, and pending-decision resume. A Lit/Three.js live/replay viewer and
checkpointed public-perception recordings are implemented. See PROJECT_PLAN.md
for the verified current milestone and remaining work.

Legacy reconstruction is now an explicit sandboxed management operation; its
outputs remain labeled unverified and read-only (see docs/RECONSTRUCTION.md).
Open work includes historical-equivalence limits, additional scenario staging,
strict validation/engine context for every action, unsupported actions,
crash-boundary archive recovery, and deployment hardening. The broader smoke
suite reports unimplemented scenarios as SKIPs rather than passes.

### First: correct observations and outcomes

- One common response builder for action, decision, cancellation, and end.
- Authoritative position/turn/vitals on every reply; full observation by default.
- Consistent self identity, known terrain under occupants, and level boundaries.
- Turns elapsed, actual action effects, durable terminal result.

### Next: eliminate terminal choreography

- Named action dispatch and explicit self/here/direction targeting.
- Item candidate queries and deterministic name/reference resolution.
- Typed decisions and cancellation, with semantic engine context where needed.
- Revision checks, idempotent retries, bounded operation execution.

### Then: optimize and expand

- Optional map/inventory deltas and event cursors.
- More actions, richer perceived semantics, and discoverable capabilities.
- Keep the default interaction simple; do not expose implementation complexity
  just to avoid doing the work in the adapter.

This is a versioned redesign. Document supported behavior and migration rather
than changing response shapes underneath existing clients without negotiation.

## 12. Acceptance tests

These are required contract scenarios, not all completed tests. Executable
coverage lives in `lib/test_explorer.c`, `mcp/tests/`, `mcp/accept/`, and
`client/tests/browser.ts`. Missing scenarios in the broader smoke suite are
explicitly skipped. The browser checks interactive 3D play, typed decisions,
save/resume, mobile layout, and replay seeking with zero engine calls.

- Play 100 actions from action replies alone; accumulated perception matches a
  final independent snapshot. No per-move `get_state` workaround.
- Walk and exchange places with a pet; self is never presented as an enemy.
- Step onto known stairs, inspect here, descend, and replace the active map
  without mixing levels or forgetting the known stairs underfoot.
- A locked-door attempt has a structured outcome and correct turn cost. Combat
  and opening a door are not mistaken for a wall bump.
- `kick south` works without exposing a command menu or letter-based direction.
- A self-directed effect uses `target: self`; it cannot become a wait or an
  adjacent-direction action. Invalid target kinds fail before engine input.
- `eat` lists eligible perceived food in inventory and here without taking a
  turn. A known ration can be consumed by name or reference, with no letters.
- Two matching items require selection. A miss or stale reference never consumes
  an alternative object. Candidate lists do not reveal hidden item properties.
- A dangerous game warning produces a typed confirmation. Declining it does
  not restart the action. Narration pauses never require client input.
- Invalid/stale decision answers preserve the current prompt and state.
- Retrying a timed-out prayer or eating request does not perform it twice.
- Resume restores the same perception and pending semantic operation.
- Independent observation does not consume another client's events.
- Death cause survives all post-game lists. Engine failure is not reported as
  death or ascent. Victory is reported only from trustworthy terminal evidence.
- Multi-step actions terminate or suspend at bounded, documented boundaries;
  no hidden “retry until it works” loops.
