# Manual command coverage and ascension limits

**The public API is not currently ascension-capable.** It has 29 methods,
including 21 game operations, but no operation for offering the Amulet on an
altar. No start-to-ascension run has been verified. A complete method catalog
means all of this library's methods, not all of NetHack's commands.

This audit uses the vendored NetHack **5.0.0** Guidebook and source, not a manual
for a different release. Baseline: `83e3f382db914a8857cb4492c44a800266be6c7a`;
audited 2026-09-06 during NEO-19 integration. The shared checkout was changing:
source claims below refer to the named functions, and task evidence records
file hashes and actual test results. Runtime discovery and the session's pinned
package remain authoritative for a particular game. This document supplies no
additional live game observations.

The rebase onto `f1a03f8` adds `game.loot` and `game.configurePickup`;
the matrix below includes these bindings. The original attached five-scenario
audit and its 27-method count remain evidence for the earlier baseline.
The newer container and pickup contract suites cover the added operations.

## Reading the matrix

- **Shipped**: a public named binding exists. It does not imply every subcase
  has a passing engine test, or that the operation succeeds in a given world.
- **Partial**: a binding or observation covers part of the manual capability;
  the missing part is stated explicitly.
- **Unsupported**: absent from the public catalog. A standing decision cannot
  be used to initiate it. Private driver aliases are not public methods.
- **Excluded**: intentionally outside this API's control or fairness model.
- **Required** means a capability on the normal route described below. Only
  **universal blocker** means a missing verb prevents the winning operation.
  Optional strategies and role/form-specific abilities remain meaningful player
  choices; optional does not mean unimportant or dispensable in every position.

Sources: [Guidebook §§4–8](../engine/doc/Guidebook.txt),
[engine command table](../engine/src/cmd.c) (`extcmdlist`),
[public catalog](../protocol/catalog.ts), and
[shared driver](../src/explorer.c) (`cmdkey_of`, `run_scripted`, `drive_loop`,
`eligible_item`, `eligible_carried`, `equipment_key`). The table covers every
non-debug, non-internal entry in `extcmdlist`, including aliases and movement
families. The attached audit artifact enumerates all 129 such source entries;
compile-conditional host commands are inventoried, not asserted enabled.

## Shipped operations

All game requests carry `sessionId`, `requestId`, and `expectedRevision`.
All decisions are separate `decision.answer` / `decision.cancel` requests.
Use opaque item references from the current public frame. A perceived-name
query can resolve a reference or require disambiguation; labels, slots and menu
order are never item identity.

| Manual capability | Public method / actual binding | Coverage and progression relevance |
| --- | --- | --- |
| Eight ordinary movement commands (`move*`), bump melee, displacement, boulder pushing | `game.move` → one compass step | Shipped; required traversal/one combat option. A bump can attack; a failed step is not a wall or safety report. No explicit force-fight or no-attack movement prefix. |
| `wait` | `game.wait` → `donull` | Shipped; one request, possibly refused in danger. Elapsed time can include involuntary turns. |
| `up`, `down` | `game.climb` → `doup` / `dodown` | Shipped; required stairs/ladders and entrance-to-endgame transition. A portal is triggered through engine movement/trap behavior, not a new teleport verb. |
| `search` | `game.search` → `dosearch` | Shipped; one attempt. Secret doors/traps and route discoveries remain engine outcomes. |
| `kick`, `open`, `close` | `game.kick`, `game.open`, `game.close` → respective manual commands | Shipped; compass target or separate target decision. Optional obstacle/combat choices. No guaranteed lock success. |
| `pickup` | `game.pickup` → `dopickup` | Shipped; underfoot selection, including genuine engine menus. Required acquisition path. No remote pickup or automatic route. |
| `eat` | `game.eat` → `doeat` | Partial; public food-class carried/underfoot items. Sustenance supported; non-food diets under polymorph are not comprehensive. Eligibility is not corpse safety. |
| `quaff` | `game.drink` → `dodrink` | Shipped for carried potions; omitted item at perceived fountain/sink preserves engine confirmation. No dipping or guaranteed safe drinking. |
| `wield` | `game.wield` → `dowield` | Shipped for a selected carried item; useful combat preparation. Explicit empty-hand selection and swap/two-weapon management are not provided by an item reference. |
| `wear`, `puton` | `game.equip` → `dowear` / `doputon`, selected by disclosed class | Partial; armor/ring/amulet, genuine ring-hand choices. Tool accessories use `apply`. No automatic replacement of other equipment. |
| `takeoff`, `remove` | `game.remove` → `dotakeoff` / `doremring`, selected by class | Partial; exposed worn armor/ring/amulet, disclosed physical accessibility. Tool accessories use `apply`. Hidden curses do not filter candidates. |
| `read` | `game.read` → `doread` | Partial; scrolls/spellbooks including the Book of the Dead by class. Reading/studying is not spellcasting. Food labels, shirts and other novelty reading are outside the item filter. |
| `apply` | `game.apply` → `doapply` | Partial; **tool class only** on structured perception. Includes the ritual tools and many ordinary tools; see subcase matrix. |
| `drop` | `game.drop` → `dodrop` | Shipped single selection / normal stack behavior. Arbitrary quantity and `droptype` bulk control are absent. Not an altar offering. |
| `zap` | `game.zap` → `dozap` | Shipped for wands; self or compass/up/down target. Optional ranged, digging, detection and other effects depend on the wand and engine. Does not cast a spell or engrave/break a wand. |
| `pray` | `game.pray` → exact extended prayer binding | Shipped with genuine confirmation. Optional divine help; no safe cooldown or favor oracle. |
| `quit` | `game.quit` → exact extended quit binding | Shipped with genuine confirmation; abandon the adventure. Neither close nor quit is an ascension operation. |

The other eight methods are `protocol.describe`, `session.create`,
`session.observe`, `session.actions`, `session.resume`, `session.close`,
`decision.answer`, and `decision.cancel`. Lifecycle/observation methods do not
supply additional game verbs. `session.actions` is a bounded perceived-knowledge
attempt view, not an exhaustive plan or a source of hidden prerequisites.

## Existing item paths: check these before adding verbs

The category projection comes from [headless `hl_object_class`](../engine/win/headless/winheadless.c)
(the class-name switch) and the shared driver's `eligible_item`. The actual
engine dispatch is [apply.c: `doapply`](../engine/src/apply.c),
[read.c: `doread`](../engine/src/read.c),
[spell.c: `study_book`, `deadbook`](../engine/src/spell.c), and
[zap.c: `dozap`](../engine/src/zap.c). A source-reachable subcase below still
needs a fixture that exercises its precise decisions before being advertised
as tested.

| Capability | Existing path | Actual limit / evidence |
| --- | --- | --- |
| Ring Bell of Opening; light Candelabrum; attach/light candles | `apply` on tool-class items; `use_bell`, `use_candelabrum`, `use_candle` | Source-reachable. Candle attachment has a real confirmation. No new `invoke` verb is needed for these uses. Ritual not executed in this audit. |
| Read Book of the Dead at invocation square | `read` on spellbook → `study_book` → `deadbook` | Source-reachable. The Book checks the location, relic preparation and curses in the engine. No client-side ritual solver or hidden readiness field. Not runtime-verified here. |
| Unlock/relock with key/lock pick/credit card | `apply` tool → `pick_lock` | Native lock-pick target, genuine confirmation, explicit decline and cold replay passed. Actual unlock success/occupation is a separate subcase. |
| Dig with pick-axe | `apply` tool → `use_pick_axe` | Source-reachable. Dwarvish mattock and axes are weapons and fail the current tool-class filter, despite `doapply` supporting them. |
| Carried bags/boxes, stash/retrieve | `apply` tool → `use_container` | Source-reachable, typed menus must preserve object identity; no claim of complete container-menu/quantity coverage. `game.loot` handles perceived floor containers with explicit inspect/transfer decisions. Steed saddles are outside that binding. |
| Lamps, candles, lanterns | `apply` tool → light/extinguish | Source-reachable. `rub` for lamp effects is separate and absent. Oil potion ignition is excluded by the tool filter. |
| Blindfold, lenses, towel | `apply` tool → on/off/use behavior | Source-reachable. `equip/remove` filters exclude tools; they are not a replacement for this path. `wipe` remains a separate absent manual action. |
| Whistles, horns, instruments, camera, mirror, stethoscope, leash, saddle, grease, marker, horn, figurine, crystal ball, traps, tinning kit/opener, grappling hook | `apply` tool-specific behavior | Source-reachable categories; effect-specific target/item/choice/text/position decisions need individual tests. Applying a saddle is not mounting; marker writing is not floor engraving. A stethoscope report must be earned by its actual use/cost. |
| Bullwhip / polearm reach attack | `doapply` supports `use_whip` / `use_pole` | **Unsupported through current apply filter:** weapon-class items are excluded. Do not advertise `apply` as full ranged weapon coverage. |
| Rub/apply touchstone or other stones | Engine `doapply` has stone cases; `dorub` is separate | Gem-class items excluded by `apply`; no public `rub`. Optional identification strategy, not free identification. |
| Break wand, flip book/coin, apply cream pie/jelly/eucalyptus leaf/banana | Engine `doapply` supports these non-tool cases | Excluded by current public category filter. Do not create duplicate general verbs without first deciding whether narrowly expanding `apply` is appropriate. |
| Read detection scroll, study spellbook, identify/charge via scroll | `read`, then actual position/choice/text decisions as needed | Native food-detection browse/finish/cancel/cold replay passed. Study interruption is covered by existing shared tests, not re-executed for this audit. Casting learned spells is absent. |
| Use wand on self/direction | `zap`, with typed target | Native upward wand of light spent one turn and one disclosed charge, stayed in place, and exact request replay returned the same receipt. This is not proof of all wand targets/effects. |
| Equip/remove rings and armor | `equip/remove`, known class and exact item | Native hand-choice and removal/cold-receipt scenarios passed. Existing shared armor occupation tests specify five engine turns. No auto-unwield or hidden curse test. |
| Invoke artifact power | No `game.invoke`; engine `doinvoke` → `arti_invoke` | Optional, often role/strategy-specific. Wearing/wielding an artifact can provide passive powers but does not invoke its active power. A normal crystal ball can already be applied. |

## Missing ordinary choices and deliberately excluded controls

| Manual entries / capability | Status | Mandatory vs optional; nearest existing path is not full parity |
| --- | --- | --- |
| `offer` | Unsupported | **Universal blocker:** correct high-altar Amulet offering is the winning command. Ordinary corpse sacrifice is optional. `drop`, `pray`, `apply`, `read`, and `invoke` do not substitute. |
| `throw`, `fire`, `quiver` | Unsupported | Optional ranged combat, projectile/food/gem gifts, ammunition management. Wands and kicking are other tactics, not an implementation of throwing. First bounded proposal below. |
| `engrave` | Unsupported | Optional player writing/warding/wand use; ordinary costs, degradation and risks must remain. No automatic protective text. |
| `chat` | Unsupported | Optional deliberate dialogue, priest services, shop price queries and hints. Quest leaders can initiate the necessary conversation themselves; see route. |
| `enhance` | Unsupported | Optional skill advancement/checks; critical for many builds but not a universal win trigger. Passive practice does not replace choosing an advancement. |
| `cast`, `showspells` | Unsupported | Optional learned-spell tactics and spell management. `read` can learn a spell; `zap` is wands only. |
| `invoke` | Unsupported | Optional artifact powers; distinct from the late-game invocation ritual. |
| `dip` | Unsupported | Optional blessing/curse removal, potion mixing, fountain/weapon strategies. Drinking and dropping at an altar do not dip an item. |
| `pay` | Unsupported | Required for an ordinary **paid-shopping** route, not for every ascension route. Do not assume the guaranteed candle shop is usable: this route must obtain candles without requiring payment or wait for `pay`. |
| `loot`, `tip` | Partial | `game.loot` supports perceived floor containers and staged transfers. Saddle interactions and `tip` remain unsupported. |
| `force`, `untrap` | Unsupported | Optional lock forcing and disarming/rescue. `kick/open/apply` are different attempts, not untrap. |
| `fight` prefix | Unsupported | Optional forced attacks toward an empty/apparently empty square. Bump movement is available but is not an explicit no-move attack at an unseen target. |
| `swap`, `twoweapon`, `takeoffall` | Unsupported | Optional combat/equipment management and bulk undressing. Individual wield/remove does not supply secondary-weapon slots or two-weapon mode. |
| `jump`, `ride`, `monster`, `turn`, `teleport` | Unsupported | Role/form/intrinsic/equipment-dependent manual abilities. `turn` is priest/knight turning; `monster` includes polymorph abilities. Spell/wand/item teleport effects are separate from the intrinsic teleport command. |
| `rub`, `sit`, `wipe` | Unsupported | Optional lamp/stone effects, throne/egg/rest behavior and face wiping. A towel is an item-based alternative with different requirements. |
| `inventory`, `inventtype`, `seeall`, `seeamulet`, `seearmor`, `seerings`, `seetools`, `seeweapon`, `showgold` | Partial via observation | Current perceived inventory/equipment/status can be displayed/filtered locally without a new engine input. Do not claim complete shop credit/debt or every manual inventory view is present. |
| `attributes`, `conduct`, `chronicle`, `known`, `knownclass`, `genocided`, `vanquished`, `overview` | Partial/unsupported information views | Some self-state/current inventory/events are in observation; full manual attributes, conduct, persistent discoveries, kill lists and dungeon overview are not equivalent to a current frame. Preserve only already-disclosed information; no hidden lookup. |
| `look`, `lookaround`, `glance`, `whatis`, `showtrap`, `terrain` | Partial via observation | World/local facts describe perceived cells; not complete interactive manual look/lore/trap/terrain views. A missing exposed inscription or landmark could be a progression/perception gap and requires a real scenario, not an invented value. |
| `herecmdmenu`, `therecmdmenu` | Partial via `session.actions` | Bounded local attempts; no raw engine context-menu route to other verbs. |
| `annotate`, `call`, `name` | Unsupported in engine | Optional naming/annotations. A client may retain user notes; it must not masquerade them as identified engine facts. Naming an artifact is an engine-affecting choice and is not reproduced by a note. |
| `adjust`, `perminv`, `redraw` | Excluded presentation controls | Inventory letters/window scrolling/redraw are not protocol identity. Client presentation can implement its own layout. |
| `prevmsg` | Partial via retained public events/heard text | No engine message-history command; current frame is not a complete historical recording. |
| `#`, `?`, `help`, `whatdoes`, `history`, `version`, `versionshort` | Excluded/replaced interface controls | Library docs/discovery/package identity replace command entry/help/version UI. No arbitrary extended-command string. Local manual remains reference material. |
| `autopickup`, `options`, `optionsfull`, `toggle`, `saveoptions` | Partial/excluded configuration commands | `game.configurePickup` journals supported ground-pickup settings without time cost. Other general option mutations remain excluded; package/profile replay integrity is retained. |
| `run`, `rush`, all eight `run*` and eight `rush*`, `travel`, `retravel`, `repeat`, count/`reqmenu` movement prefixes | Excluded automation/prefix surface | Explicit single operations only. No auto-travel, no repeated occupations, no hidden-route planner. Absence of no-pickup/no-attack prefix is also an ordinary agency limitation. |
| `droptype` | Unsupported bulk choice | Individual `drop` exists; no quantity/bulk-selection promise. |
| `save` | Replaced lifecycle | `session.close/resume` preserve pinned input journals/receipts and pending decisions; not an engine save-file API. Uncertainty is never permission to run input again. |
| `shell`, `suspend`, `bugreport` | Excluded host/process commands | No host shell, process control, or external report submission from game input. Source entries may be compile-disabled. |
| `exploremode`, all debug/wizard entries, internal mouse/alternate commands | Excluded | No public cheat, hidden-state, debug-level creation or internal-command backdoor. Debug/internal entries are outside the 129-entry ordinary-command count. |

## Concrete normal-route feasibility

This is a **source-mapped candidate route, not a playthrough or a guarantee of
survival**. Example: a lawful dwarven Valkyrie relying on melee and found tools,
wands, scrolls and equipment. Optional branches, specific loot and tactical
choices remain the player's. Each phase requires fair perception and genuine
input boundaries; source reachability alone cannot prove them.

| Phase | Manual player work and named path | Feasibility / source trail |
| --- | --- | --- |
| Start, explore, sustain, improve equipment | `session.create`; observe; explicit `move/search/open/kick/climb`; `pickup/eat/drink/wield/equip/remove`; `read/apply/zap` as chosen | Bindings exist; fresh low-level native scenarios cover several paths. No automatic food safety, combat strategy or navigation. [Guidebook §§2,4–7](../engine/doc/Guidebook.txt). |
| Optional Mines/Sokoban/preparation | Explore with single moves; push perceived boulders manually; obtain resources | Neither solving Sokoban nor Mines treasure is a universal command prerequisite. No solver. Missing pay/throw/enhance limits common preparation strategies. |
| Enter and finish role Quest; obtain Bell | Find portal by exploration; approach leader; become eligible through normal play; descend, defeat nemesis, `pickup` relic | **No mandatory chat gap proven.** [monmove.c](../engine/src/monmove.c) `dochug` calls `quest_talk` for nearby leaders; [quest.c](../engine/src/quest.c) `leader_speaks` → `chat_with_leader` grants Quest, `ok_to_quest` checks entry; [do.c](../engine/src/do.c) enforces gate. [makemon.c](../engine/src/makemon.c) assigns Bell to quest nemesis. No fresh Quest fixture here. Manual `chat` still missing. |
| Reach Castle/Gehennom | Traverse stairs/doors/obstacles; apply musical instrument with real tune decisions, or use appropriate digging/other manual route where engine permits | `apply/read/zap/climb` cover plausible alternatives, not all Castle paths. Castle wand of wishing is optional. A wish, when actually earned, must be answered as the engine's text decision; no wish command. [apply.c](../engine/src/apply.c), [music.c](../engine/src/music.c), [dig.c](../engine/src/dig.c). |
| Acquire Candelabrum and Book, gather seven candles | Explore Vlad's tower/Wizard area, ordinary combat, `pickup`; acquire candles without relying on unbound `pay` | [makemon.c](../engine/src/makemon.c) relic assignments; [dat/wizard1.lua](../engine/dat/wizard1.lua) Book placement. No guaranteed loot or survivability claim; paid-shop acquisition needs `pay`. |
| Discover vibrating square and perform invocation | At the perceived location: attach candles via `apply` with explicit confirmation; light Candelabrum; ring Bell; promptly `read` Book | **Existing named verbs**, not `#invoke`. [apply.c](../engine/src/apply.c) `use_candle/use_candelabrum/use_bell`; [spell.c](../engine/src/spell.c) `deadbook` requires seven lit candles, recent Bell and appropriate uncursed relics at invocation position, then `mkinvokearea`. These are engine rules, not eligibility fields or a new ritual macro. Perception of the square and exact decision chain remain untested here. |
| Enter Sanctum; acquire real Amulet | Descend generated stairs, explore/find concealed route, fight, `pickup` | [mkmaze.c](../engine/src/mkmaze.c) `mkinvokearea`; [priest.c](../engine/src/priest.c) `priestini` supplies Sanctum high priest's Amulet. Bound operations plausibly suffice, but not run here. |
| Return to dungeon entrance carrying Amulet | Explicit movement and `climb(up)`, handle real obstacles/warnings | [do.c](../engine/src/do.c) `doup`, `goto_level` handle entry into endgame with Amulet and return-path effects. Escaping without Amulet is not winning. |
| Cross Earth, Air, Fire, Water to Astral | Dig/move with appropriate tool/wand, use chosen equipment for traversal; find and enter actual portals | [dat/dungeon.lua](../engine/dat/dungeon.lua), [teleport.c](../engine/src/teleport.c) `domagicportal`, plane level sources in `engine/dat/`. Bindings provide plausible traversal/detection equipment paths. No free portal coordinates, optimal path or guaranteed equipment. All plane scenarios unexecuted. |
| On own deity's high altar, offer real Amulet | **Needs future `game.offer`**, selecting actual carried/underfoot reference | **Blocked today.** [pray.c](../engine/src/pray.c) `dosacrifice` → `offer_real_amulet` → `done(ASCENDED)` for matching altar alignment. Wrong/fake/early offerings have different consequences. [Guidebook §8](../engine/doc/Guidebook.txt) explicitly says offering Amulet is necessary even for atheist conduct. |

The audit establishes one universal **missing-command** blocker (`offer`). It
does not establish that implementing that command is sufficient for ascension:
late-game item decisions, end-state projection, inscriptions/landmarks, portal
perception and full route replay still require actual native/WASM scenarios.
`chat`, `invoke`, `enhance`, `engrave`, ranged weapons, `pay`, `cast` and `dip`
are missing player choices, not all mandatory verbs on every legitimate route.

## Smallest first follow-up: one explicit throw operation

**Proposal only; not shipped:** `game.throw` restores one ordinary item-and-
direction attack/gift operation. It is intentionally separate from the mandatory
`offer` follow-up. Do not bundle firing/quiver management, engraving, skills or
a complete command-set rewrite into its implementation.

Proposed request (in addition to the three standard guards): optional `item`
with the existing opaque-reference/perceived-query schema; optional `target`
with `{direction: compass | "up" | "down"}`. No target creature ID, coordinates,
self target, range, hit probability, raw key, repeat count or automatic launcher
selection. Omitting an item yields a zero-turn candidate decision; omitting the
target yields the genuine target decision after exact item binding. Direction
is a manual attempt even when no creature is visible. `self` is excluded because
`throw_obj` explicitly refuses it; throwing upward retains its ordinary risk.

The first version uses **one unprefixed engine throw command**, including its
normal skill/role-dependent volley and normal coin-stack behavior. It must say
this in discovery and human help: one request does not promise one projectile.
There is no caller-selectable quantity in this first increment. A later explicit
shot limit can use the engine's command-count facility (which differs from item
stack count); it must never be implemented as repeated throw requests. This
bounded omission is a real ammunition-control limitation.

Implementation plan through the existing boundaries:

1. Add one entry in `protocol/catalog.ts`, regenerate C dispatch metadata,
   TypeScript and MCP schemas with Node, and add the typed C API entry in the
   existing public pattern. The shared C driver supplies the exact `dothrow`
   binding and recognizes the operation throughout item/target decision handling.
   Nothing in TS, worker, MCP or the pixel client calculates throw rules.
2. Candidate set: currently perceived carried items, not floor objects or hidden
   inventory. Do not filter curses, petrification, poison, charges, artifact
   readiness or viability. Bind via the headless object identity channel. Preserve
   the engine's refusals, dropped/split/returning objects and ordinary costs.
3. Carry initiating item/target intent through each standing decision. Show real
   confirmation/item/target/choice decisions when produced, stop on unsupported
   prompts, and do not auto-confirm peaceful attacks or any other warning. Allow
   cancel only when declared cancellable; do not invent confirmations where the
   manual engine has none.
4. Preserve standard reservation-before-input, exact receipt retries, revision
   guards, pending context hashes, one writer and same-package resume. A target
   answer is its own immutable request; repeat that answer's request after a
   timeout, never the initial throw. A missing receipt remains uncertain.
5. Report actual `turnsElapsed`, resulting public inventory and perceived events.
   Do not compute impact targets, HP, trajectory, dropped-object identity or
   success from hidden state. If new outcome vocabulary is needed, add only an
   engine-witnessed event through the shared schema rather than label parsing.

Source: [dothrow.c](../engine/src/dothrow.c) `dothrow`, `ok_to_throw`, `throw_obj`,
`throw_ok`: selection and direction; cancellation with no turn; restrictions,
touch hazards and welded-item costs; role/skill volley; special gold behavior.
`dofire`/`autoquiver` are separate and must not run to implement manual throw.

Required tests before this proposal can be called implemented:

| Fresh actual-engine scenario (shared native/WASM) | Required assertion |
| --- | --- |
| Starting missile stack, explicit public ID and direction; omitted item/target variants | Exact chosen object; one engine command; public stack change and engine turn cost; no implicit quiver or launcher change. Test default volley and gold behavior separately. |
| Two same-label objects, stale/unknown ID, wrong category/location, bad direction | No first-match or floor substitute; invalid requests spend no input/turn; known-state filtering never becomes a hidden-property oracle. |
| Genuine direction cancellation and item/target/confirmation decisions | Correct decision ID; no repeated initiating operation; explicit decline stays declined; no automatic attack consent. |
| Empty square, visible creature, sensed/remembered/unknown cell; hidden-monster equivalence before input | Eligibility/offer reveal no unseen targets. Engine may hit unseen things after real input; report only perceived consequences. No special floating-eye policy. |
| Known/unknown welded weapon, returning weapon, hazardous corpse, upward projectile | Actual engine refusal/cost/inventory and death/return behavior; no safety filtering or guessed success. Rare states need new test-engine fixtures, not old saves. |
| Lost reply after item initiation and after target answer; native restart, WASM memory/IndexedDB reopen | Exactly one committed execution per request; identical receipts; pending choice survives same-package resume; missing/uncertain receipt blocks further input. Real browser transaction/ownership checks remain enabled. |
| Terminal result during throw, changed package, schema/header/catalog drift | Terminal state remains terminal; no binary upgrade/replay; all generated/public surfaces agree. |

## Mandatory follow-up design: offer (separate increment)

**Proposal only:** `game.offer({item?})`, standard guards, no target field because
it acts at the hero's current altar. Omitted item exposes eligible perceived
carried/underfoot references or the engine's genuine floor/selection decisions.
Expose the ordinary broad corpse/Amulet selection choices from disclosed
categories/prompt data. Never distinguish a real Amulet from a convincing fake,
fresh corpse from stale, or successful sacrifice from failure by candidate
filtering. Unknown location/altar properties must not become a free oracle.

Shared C binds exactly `dosacrifice`, preserves `floorfood` item provenance and
all decisions; the catalog generates all public surfaces. Known underfoot altar
terrain may describe an attempt, never that the deity will accept it. The engine
checks impairment, altar conditions, item properties and alignment, consumes
items/spends turns where appropriate, and ends the game where appropriate.
Do not wrap it as `ascend`, substitute a `drop`, auto-pick an Amulet/altar, add
an automatic ritual, or silently add confirmation to every offer. Surface each
genuine confirmation, and make the client explain the possible final action
before the player chooses to issue it.

Test new temporary engine fixtures on native and WASM: no altar; impaired
hero; carried versus floor selection with duplicate labels; stale references;
corpse offerings with varied hidden age/curse/alignment and identical public
candidate projection; real/fake Amulet on ordinary/wrong/own high altar; genuine
prompt decline/cancel; exact request/answer receipt replay; terminal winning
result survives observe/retry/close/resume without repeated offering. Fixture
setup is test-only and must not expose hidden altar alignment/Amulet identity to
a live client. Add actual sandboxed browser persistence/ownership checks.
A fixture reaching `ASCENDED` proves this terminal path, **not a legitimate
start-to-ascension playthrough**.

Other missing commands remain the roadmap, not selected implementations:
manual `chat`, `enhance`, `engrave`, `pay`, `cast`, `dip`, `invoke`, `tip`,
then remaining role/form/equipment abilities and broader apply/read eligibility.
Prioritize with real scenarios and player needs; keep each named and independently
reviewable. An eventual ascension claim additionally needs an unmodified,
non-debug start-to-finish run with pinned package identity and complete public
request/response evidence. Such evidence must not expose private saves or
retrospective hidden state to a live player.

## Client presentation and acceptance evidence

Human and agent clients must use the actual catalog for the session's backend
and package. Missing commands are unavailable on both surfaces: do not render
working throw/offer/etc controls, suggest raw extended-command input, or advertise
an ascension button. If listed for orientation, disable them with the same reason:
"Not supported by this package; see command coverage." A method's absence is
not proof of an engine rule or in-world prohibition. Both surfaces can link this
document; available item actions still need to explain their narrower category
scope. The pixel client's named-offer dispatch and generated MCP schema have
no throw/offer bindings; a complete UI walkthrough was not performed by this audit.

Fresh **native checks run for this audit** (parent-granted runtime slot; no
builds by this worker):

- Existing `affordance.test.mjs`: lock-pick apply target/confirmation, explicit
  decline, observed door evidence and cold replay.
- Existing `gameplay.test.mjs`: ring removal/exact receipt after restart;
  synthetic equipment selection plus genuine hand choice (two scenarios).
- Existing `position.test.mjs`: food-detection read with browse/finish/cancel,
  coordinate answer and cold replay (one scenario).
- Attached `native-capabilities.mjs`: named upward zap of a fresh wizard's wand
  of light spent one turn and changed disclosed charges from 15 to 14; exact
  request replay was identical; `apply` rejected that wand; eight unbound methods
  were rejected without changing observation (one scenario).

These are **five actual scenario tests**, not 27-method conformance, exhaustive
tool coverage or ascension. The first filtered Node invocation also reported a
file-level pass for a file with no matching test; that is not counted as a
scenario. A subsequent unfiltered run executed its real read test. All stores
were newly created temporary stores and removed by the existing fixture. No raw
keys, private historical sessions, repaired recordings or browser sandbox changes.
Parent NEO-19 owns full native/WASM/browser integration; this audit did not run
its own WASM/browser suite. The report and task attachments distinguish test
output from source inference and proposed acceptance tests.

**Acceptance status:** the parent confirmed that this scoped audit/design
handoff is satisfied by the complete matrix, README link, explicit reference-
client limits and selected-command proposals. It is ready for review. New
commands are not implemented; their proposed native/WASM/browser tests have
not run. Those future implementation criteria and unexecuted endgame scenarios
remain explicit follow-ups, not evidence of release readiness or ascension.
