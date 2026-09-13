# Event-driven hero API

Start with [How an agent plays](AGENT_PLAY.md) for the short interaction guide.
The shared `game.route({x,y})` query plans known walking paths without moving;
see [route semantics](PROTOCOL.md#known-walking-routes). Hero remains the event and
script convenience layer; routes do not automatically run a travel loop.

The workshop runs one initialization callback, then an awaited `turn` listener.
No manual loop is needed. `defineBot` contextually types both JavaScript and
TypeScript, including event names and their payloads.

```ts
import { defineBot, direction, entities } from 'neonethack';

export default defineBot({
  name: 'Curious imp',
  autoloot: { enabled: true, itemTypes: ['gold', 'food', 'armor', 'weapons'], arrows: false, leaveCorpses: true, leaveKnownCursed: true, lootPatterns: ['ration', 'dagger'], ignorePatterns: ['corpse'] },
  initialize({ hero, game, log }) {
    hero.addEventListener('enterLevel', ({ detail }) => {
      log('Entered', detail.to.depthLabel);
    });
    hero.addEventListener('itemSeen', ({ detail }) => {
      log('New observation:', detail.sighting);
    });
    hero.addEventListener('turn', async () => {
      if (hero.decision) { hero.stop(); return; }
      const enemy = hero.senseClosest(entities.Enemy);
      if (enemy?.distance === 1) await hero.attack({target:enemy});
      else await hero.game.move(direction.northWest);
    });
  },
});
```

A custom host calls `await runBot(game, bot, log)`. Alternatively, instantiate
`new Hero(game)`, register listeners, and call `await hero.initialize(setup)`.
Initialization is allowed once per Hero, and only one lifecycle owns a Game.
These exports are also available from the browser client and
`/component/neohack.js`.

## Lifecycle and events

Initialization registers listeners and local strategy state. The lifecycle first
publishes the initial observations, then calls the single `turn` listener.
Callbacks are awaited in registration order. Observation callbacks are read-only;
input belongs in `turn`, `beforeLoot`, or a queued control callback. All operations there must be awaited. Multiple awaited
operations are allowed: every intermediate snapshot is queued and published in
order before the next turn callback. Notification payloads belong to their
`detail.snapshot`; always re-sense current handles when selecting an action.

`turn` means a strategy boundary, not necessarily one engine turn. An operation
may use zero or several engine turns. Standing decisions also reach this callback
and must be answered or cancelled explicitly. An idle callback ends the run; it
does not implicitly wait or poll. `hero.stop()` stops the bot after the current
callback without quitting the game. The returned `BotResult` gives the reason:
`stopped`, `idle`, `ended`, `decision`, `uncertain`, `noTurnListener`, or `yielded`.

| Event | `detail` payload beyond `snapshot` |
| --- | --- |
| `snapshotChange` | `previous` snapshot, or null initially |
| `enterLevel` | `from` location (null initially), `to` location |
| `mapChange` | `changes`: immutable before/after cell pairs |
| `entitySeen` | A revision-bound `entity` sighting |
| `entityLost` | The previous `cell`; not evidence of death |
| `itemSeen` | `sighting`: inventory/here item ID, or map cell glyphs |
| `inventoryChange` | `previous` snapshot; freshness stays explicit |
| `vitalsChange` | `before`, `after` vitals |
| `decision` | `decision`, including null when cleared |
| `message` | Public engine message `text` |
| `actionResult` | `outcome` from an operation |
| `end` | Engine `end` record |
| `turn` | Main strategy callback |
| `stop` | Lifecycle `reason` |
| `error` | Original `error`; it is rethrown to the host |

`addEventListener(name, callback, { once: true })` and
`removeEventListener(name, callback)` are supported. Duplicate registration of
the same callback is ignored. Only one `turn` listener coordinates input.
Repeated pure `observe()` calls do not replay events. Listener exceptions stop
the lifecycle. Transport uncertainty preserves the exact pending request and
never causes an automatic retry or another turn. Missing awaits are reported
after settling pending work, rather than leaving orphaned input behind.

Entity events describe visible sightings at squares, not persistent monster IDs
or spawn/despawn events. A creature moving to a different square may yield lost
and seen events. No unseen movement or death is inferred. Item sightings likewise
describe disclosed information; map glyphs do not acquire invented item IDs.
Cross-level maps are treated as separate maps, and first observations are emitted
on entry. Unknown inventory is not interpreted as empty inventory.

## Sensing and actions

`direction` is a string enum: `north`, `northEast`, `east`, `southEast`, `south`,
`southWest`, `west`, `northWest`. `entities` includes `Creature`, `Enemy`, `Ally`,
`Peaceful`, and generated apparent species such as `Balrog`, `Kitten` and
`FloatingEye`. Enemy requires an explicitly perceived hostile attitude.

`hero.sense(filter)` returns visible creatures sorted by geometric Chebyshev
distance, then y/x. `senseClosest(filter)` returns the first or undefined.
An Entity has `type`, `appearance`, `attitude`, `kind`, `position: [x,y]`,
`offset: [dx,dy]`, and `distance`. Positive x is east; positive y is south.
A perceived Balrog two west and one north has `type === entities.Balrog` and
`offset === [-2,-1]`; no hidden statistics are disclosed.

`hero.go({to})` plans a bounded navigation leg to coordinates or a fresh
perceived Entity. `hero.go({direction})` attempts one ordinary step, including
opening, companion swaps and possible pushes. Displayed creatures are refused;
use `attack` for a deliberate attack. Engine rules and standing decisions apply.

`hero.attack({target})` is distinct: a fresh perceived creature reference or an
adjacent coordinate (including an apparently empty square) becomes the precise
low-level force-attack operation. Engine confirmations remain explicit. Handles
are bound to their Game, level and revision; re-sense after acting. Direct compass
steps remain available through `hero.game.move(direction)`.

`hero.position`, `location`, `map`, `vitals`, `snapshot`, `decision` and `ended`
expose public observations. `hero.steps` lists adjacent squares with the C
driver's movement facts, actions and a typed direction. `canDescend()` reads the
engine's current downward climb offer, or returns undefined if unavailable.
`wait()`, `search({turns})`, `rest({turns})`, `climb('up'|'down')`, and the complete `hero.game` API remain
available. No path, safety, or success guarantee is implied by an attempt.

## Hunger and items

`isHungry()` returns true for disclosed hungry, weak, fainting or fainted;
false for not-hungry or satiated; undefined for unknown status.

`hero.inventory.items` returns current ID-bound handles with `info` (public
label, category, quantity, usage and eligible actions). `byId(id)` selects an
exact ID or returns undefined. `freshness` distinguishes current/lastKnown/unknown.
`hero.itemsHere` returns current floor handles, or undefined for unknown floor
knowledge. Item handles expire at the next revision.

`item.canEat()` and `canEquip()` read the C-authored item `actions` list. They return
undefined when unknown. Eligibility does not reveal curses, food safety or
whether equipment will fit; the engine checks the attempted action.

`hero.inventory.find('bread')` is a lazy engine-resolved name query, not a JS
substring match or a claim that bread exists. `.eat()` forwards it to C; missing
or ambiguous names throw `WorldError` with the blocked response, without choosing
a first match. Use `byId` or `items` for exact selection. Handles support `pickup`,
`eat`, `drink`, `wield`, `equip`, `remove`, `read`, `apply`, and `drop`.

## The imp starter

The editable workshop starts with `main.ts` (one initialization and event
listeners) and `strategy.ts` (exploration preferences). It biases random movement
toward unknown areas and away from repeated visits, retreats from known enemies,
eats eligible inventory food when hungry, tries each newly observed wearable
item, picks up items, searches, and descends known stairs. It declines warnings
and logs unhandled decisions. The engine may still block attempts, and the imp
can make poor choices or die. It does not promise an ascension or a maximum depth.

These preferences live in the example bot, not the library or WASM adapter.
Autocomplete (Ctrl+Space), hover documentation and advisory type diagnostics use
the actual built declarations across all project files. Test transpiles JS/TS;
relative imports and `neonethack` are supported, without npm or network access.

Every bot definition requires a nonempty `name` (up to 60 characters). This is
its executable identity; a workshop project's editable label can differ.
`autoloot` accepts the protocol's `AutomaticPickup` rules at construction.
`runBot` applies them through `game.configurePickup` before `initialize`: a
journaled configuration operation that spends no turn. Engine errors propagate;
containers and standing decisions remain explicit. Omit `autoloot` to retain
an existing game's settings. Use `game.configurePickup` to change them later.

Signed-in workshop tests archive the exact original files, compiled files,
compiler version and construction autoloot before initialization. Account history
marks these runs as automated and exposes their private source independently of
later project edits. This is browser-reported provenance, not execution attestation.
Anonymous tests are temporary; `runBot` used outside the workshop does not upload
or infer its caller's source.

## Script state, composition and player control

Every Hero starts with `hero.state === 'run'`. This is script strategy state;
`hero.snapshot` remains the complete public engine snapshot. State is a string,
a frozen JSON object, or null. It never replaces engine facts.

Initialization, every event listener and control callback may return a state name,
`null`, or `{state: {mode: 'explore', target: [3, 4]}}`. Returning nothing or
a boolean leaves state unchanged (false vetoes inside stateChange). Snapshot action results remain snapshots,
so `() => hero.wait()` does not change script state. Compose ordinary functions
inside the single turn listener; returning their result forwards their state change.
An action-free turn still stops as idle, even if it changes strategy state.

`await hero.setState(next)` proposes a transition. Before committing it, the
`stateChange` event supplies `detail.from`, `detail.to`, and `detail.deny()`.
Returning false also vetoes; returning a state replaces the proposal for subsequent
listeners. Return replacements rather than recursively calling setState there.
A veto cannot undo a game action that already happened.

```ts
hero.addEventListener('stateChange', ({detail}) => {
  if (detail.to === 'explore' && hero.isHungry()) return false;
});
hero.controls.checkbox({id:'flee', label:'Flee enemies', checked:true,
  onChange: checked => ({state: {mode:'run', flee:checked}})});
hero.controls.button({id:'pause', label:'Yield control', onClick: () => null});
hero.journal.log('Looking for downstairs');
```

Once state becomes null, **no further script callbacks fire**, including later
listeners of that event, observations, state transitions, controls, stop or error.
The lifecycle returns `reason: 'yielded'` and releases its Game. Already submitted
engine input settles; it is never undone. Journal writes and control registration
are inactive while null. Hero action conveniences reject input while suspended.

A trusted host receives `runBot(game, bot, log, {ready, state, controls, journal})`
notifications and retains Hero from `ready(hero)`. It invokes controls through
`hero.controls.invoke(id, checked?)`; callbacks queue behind active input and
must await all their operations. Never await invoke from a script callback itself.
A player override uses `hero.setState(value, {force:true})`, bypassing script
vetoes and superseding results from an older awaited callback. To resume a yielded
script, force a non-null state and call `hero.resume()`. Inputs made by the human
while null are not replayed as script events; the current scene is published on resume.

The workshop exposes the controls and player state override. Yield ends its test;
its world component stays read-only. Attaching scripts to a live human game is a
separate host integration. The full `game` API remains available: the SDK is a
cooperative lifecycle, while the workshop sandbox enforces termination externally.

## Loot witnesses and explicit review

Autoloot construction accepts `review: true`. When automatic pickup finds a
matching item, the engine pauses **before transfer** with a real choice decision.
Options carry `suggested` flags from the configured loot/ignore rules; nothing
is silently selected. `beforeLoot` can explicitly select offered IDs or cancel:

```ts
hero.addEventListener('beforeLoot', async ({detail}) => {
  const wanted = detail.decision.options.filter(option => option.suggested);
  if (detail.source === 'pickup') await detail.select(wanted.map(option => option.id));
  else await detail.cancel(); // container transfer policy belongs to this script
});
hero.addEventListener('itemLooted', ({detail:{loot}}) => {
  hero.journal.log('Acquired', loot.quantity, loot.item.label, 'from', loot.source);
});
```

Cancel a standing choice before calling `hero.inventory.byId(id)?.drop()`.
Re-read inventory after cancellation because item handles are revision-bound.
The hook also receives explicit container transfer menus, including take/put offers;
use their disclosed intent and quantity data instead of assuming all are pickup.

`itemLooted` is an engine witness: acquired quantity, resulting inventory ID and
stack size, source (floor/container/engulfer), and container when applicable.
`containerOpened` discloses the inspected container and its observed contents;
it does not fire merely because a locked or trapped attempt was made. These events
report outcomes, and cannot veto them. Only the standing before-transfer choice
can change what is taken. IDs in event payloads describe that receipt, so obtain
fresh action handles before acting.

Script notes are labeled with author and turn, and stored separately from engine
messages, input journals and receipts. Signed-in workshop recordings retain their
script journal privately alongside the captured source and replay. Anonymous tests
retain notes only for the current page; neither makes script claims into engine facts.

## Optional navigation

```ts
import { Navigator } from 'neonethack/high';
const navigator = new Navigator(game); // explicit opt-in for this Game
const leg = await navigator.explore({ maxActions: 8 });
console.log(leg.reason, leg.actionsTaken, leg.snapshot.outcome);
```

`go({to:{x,y}})` plans and attempts a known route on the current level. A
displayed tame ally on the route is displaced by ordinary movement (the engine
reports `swappedPlaces`); other occupants are never routed through.
A `noRoute` result includes `why` (`targetOccupied`, `targetUnknown`, `closedDoor`
or `disconnected`) and a `hint` for the next explicit tool. `lastOperationId` names
the last confirmed input; it does not request recovery. A normal partial leg
already includes its final confirmed scene for deciding what to do next.
`explore()` selects the nearest reachable unvisited frontier for one leg. If none
is reachable, it approaches a remembered closed door not known locked and makes
one explicit open attempt, then stops. It does not pick locks, kick or repeat
a resisted opening.
When no frontier or door is reachable, exploration can probe an adjacent unknown
square, including diagonals, using C-provided movement offers. Its policy skips
known restrictions, squeezes, occupants and disclosed hazards; it does not infer
corner rules in JavaScript or treat an uncertain attempt as guaranteed passage.
Pass `maxFrontiers` to explicitly continue across several successive perceived
frontiers, for example `explore({maxFrontiers:20,maxActions:80})`. It defaults to
one; the action budget applies to the whole call, and a door attempt still ends
it. Frontier continuation uses freshly queried perceived routes and retains all
decision, interruption and changed-condition stops.
`descend()` selects the nearest reachable remembered downward stair, travels to
it and attempts the engine's climb command. `maxActions` defaults to the full level bound of 1,659 and can be reduced; it counts submitted move/open/climb attempts, not elapsed game turns.
Pass an `AbortSignal` to stop between inputs. A pending decision, interruption,
level change during travel, condition or hunger change, or a newly perceived creature ends the leg. No warning
is answered, blocked action repeated, or uncertain operation retried.
If a later substep fails, `NavigationError.result` retains the confirmed actions,
turns and last confirmed snapshot; its `cause` retains the underlying error.
An uncertain failed input may have executed beyond that snapshot. Recover the
retained exact input through the SDK's receipt/request recovery path. In MCP,
`syncState` verifies its receipt and reads current state without resending gameplay;
unavailable verification keeps input blocked. Never restart navigation as recovery.

Route and frontier semantics live in C. This executor only submits the named
operations with their observed revision and returns the actual final snapshot.
Known-walking routes exclude closed doors; the exploration leg uses the separate
C-provided door approach and named opening action. World-only evaluations do not instantiate a
Navigator or call navigation queries.

### Encyclopedia reference

`await hero.lookup("floating eye")` (also `game.lookup`) reads the pinned game’s
encyclopedia. The returned `kind: "lore"` and `lines` are reference text, separate
from perceived entities. No turns are spent and pending decisions stay open.

### Counted occupations

`hero.search({turns:20})` and `hero.rest({turns:20})` request one native counted
command. Counts default to one and range from 1 to 1000. The engine may refuse
or interrupt before finishing. Use the returned actual elapsed turns and
`outcome.status`; no callback automatically resumes the occupation. The same
methods are available on `game`.

`hero.go({to})` accepts any square on the current level. It follows known routes
until arrival, a real decision, changed circumstances or no known route; it does
not guess unexplored terrain. `hero.explore()` and `hero.descend()` expose the same
helpers as MCP/WebMCP, and accept `maxActions`, `signal` and `onStep`.
