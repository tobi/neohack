# Event-driven hero API

The workshop runs one initialization callback, then an awaited `turn` listener.
No manual loop is needed. `defineBot` contextually types both JavaScript and
TypeScript, including event names and their payloads.

```ts
import { defineBot, direction, entities } from 'neonethack';

export default defineBot({
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
      if (enemy?.distance === 1) await hero.attack(enemy);
      else await hero.go(direction.northWest);
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
input belongs in `turn`. All operations there must be awaited. Multiple awaited
operations are allowed: every intermediate snapshot is queued and published in
order before the next turn callback. Notification payloads belong to their
`detail.snapshot`; always re-sense current handles when selecting an action.

`turn` means a strategy boundary, not necessarily one engine turn. An operation
may use zero or several engine turns. Standing decisions also reach this callback
and must be answered or cancelled explicitly. An idle callback ends the run; it
does not implicitly wait or poll. `hero.stop()` stops the bot after the current
callback without quitting the game. The returned `BotResult` gives the reason:
`stopped`, `idle`, `ended`, `decision`, `uncertain`, or `noTurnListener`.

| Event | `detail` payload beyond `snapshot` |
| --- | --- |
| `stateChange` | `previous` snapshot, or null initially |
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

`hero.go(directionOrEntity)` attempts **one** compass step. Going toward an
entity uses the signs of its offset and performs no pathfinding. Normal bump
rules apply. `hero.attack(entity)` requires an adjacent, known hostile creature.
It never force-attacks or confirms warnings. Handles are bound to their Game,
level and revision, including across queued operations; re-sense after acting.

`hero.position`, `location`, `map`, `vitals`, `state`, `decision` and `ended`
expose public observations. `hero.steps` lists adjacent squares with the C
driver's movement facts, actions and a typed direction. `canDescend()` reads the
engine's current downward climb offer, or returns undefined if unavailable.
`wait()`, `search()`, `climb('up'|'down')`, and the complete `hero.game` API remain
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
