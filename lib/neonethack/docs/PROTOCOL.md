# Semantic protocol v1

A request names a method. It does not mix an action with a reply to a previous
choice. All transports invoke the same validating C boundary.

```json
{"version":1,"method":"session.create","params":{"name":"Ada","seed":42}}
{"version":1,"method":"game.move","params":{"sessionId":"g-...","requestId":"step-1","expectedRevision":0,"direction":"south"}}
{"version":1,"method":"decision.answer","params":{"sessionId":"g-...","requestId":"answer-1","expectedRevision":1,"decisionId":"decision-3","answer":{"kind":"confirmation","confirm":false}}}
```

The exact request grammar is [request.schema.json](../protocol/request.schema.json).
The exact supported methods and their descriptions are in
[catalog.json](../protocol/catalog.json), also returned by `protocol.describe`.
These artifacts and C validation data are generated together by
`node scripts/generate.ts`; CI must reject stale generated files.

`session.create` accepts `{}`: C selects a random seed and generates a hero name,
and the engine selects a compatible role, race, gender and alignment. Supplied
fields remain explicit choices. An omitted name is derived from the seed using
a separate mixer, without consuming the engine or host's global random stream.
The concrete name and seed are recorded before `new_game`; resume reuses them.
Generated names are ASCII, at most 31 bytes, and contain no identity suffixes.

MCP/WebMCP names use underscores without a product prefix: `session_create`,
`session_observe`, `game_move`, `decision_answer`, etc. The underlying library
protocol continues to use dotted method names.

## Method families

| Family | Methods |
|---|---|
| Discovery | `protocol.describe` |
| Session | `session.create`, `session.observe`, `session.resume`, `session.close` |
| Movement | `game.move`, `game.moveWithoutAttack`, `game.attack`, `game.wait`, `game.climb` |
| Environment | `game.search`, `game.kick`, `game.open`, `game.close`, `game.pray`, `game.quit` |
| Items | `game.pickup`, `game.eat`, `game.drink`, `game.wield`, `game.equip`, `game.remove`, `game.read`, `game.apply`, `game.drop`, `game.zap` |
| Containers | `game.loot` |
| Ranged and weapons | `game.throw`, `game.fire`, `game.quiver`, `game.swap`, `game.twoWeapon` |
| Spells and skills | `game.cast`, `game.enhance`; inspect `observation.knowledge` |
| Manual interactions | `game.offer`, `game.pay`, `game.chat`, `game.dip`, `game.rub`, `game.invoke`, `game.engrave` |
| Automatic ground pickup | `game.configurePickup`; read `observation.automaticPickup` |
| Continuation | `decision.answer`, `decision.cancel` |

There is deliberately no generic `act`, raw key, travel-until-success, or menu
reply method. Inspecting self/here/inventory is a projection of the observation,
not a gameplay action. Unsupported actions are not advertised.

### Targets and items

`move` takes eight compass directions. `climb` takes `up`/`down`.
`kick`/`open`/`close` accept an adjacent `{direction}` target; omitting it offers a
choice. `zap`, `throw` and `fire` additionally permit `"self"` and vertical aiming. Applying a tool
accepts an item; tool-specific targets arrive as subsequent decisions.

An item is `{id:"item-..."}` or a perceived-name query. Omission requests this
command's selection flow; `offer` can first ask about floor corpses, and `wield`
and `quiver` include the explicit `hands` option. No arbitrary first match,
slot-letter fallback, hidden-property filter, or navigation is permitted.
Eligibility does not imply safety. IDs are opaque and session-scoped.

`drop({id, quantity})` accepts an explicit positive partial-stack count. Other
initial commands reject counts; a standing item decision accepts them only when
`counted:true`. Its observed stack quantity is the maximum. Omission preserves
the engine default. Counts select engine objects, never repeated requests.
Throw/fire execute one normal engine command, including any engine-controlled
multishot; this is not a caller-selected volley count.

Engine `getobj` decisions bind real object pointers to opaque references. They
offer the ordinary whole-inventory `*` view rather than disclosing hidden
eligibility rankings. The engine validates the actual attempt. Applying and
reading therefore accept non-tool/non-book uses. Equipment includes recognized
blindfolds, towels, lenses and meat rings. A perceived non-food-eating polymorph
form permits broad non-food attempts without revealing hidden edibility.
Initial item/direction arguments answer only their first matching selection;
subsequent selections remain explicit. Floor sacrifice selections use engine
object bindings, independently of genuine danger confirmations.

`cast` uses the real learned-spell menu; spell targets, failure and costs come
from NetHack. `enhance` uses the real earned-advancement menu. `invoke` activates
an artifact power; the invocation ritual still uses explicit candle attachment,
Candelabrum lighting, Bell application and Book reading. `offer` executes the
sacrifice command and can produce the genuine ascended terminal result. These
are separate operations, with no ritual or ascension macro.

### Decisions

At most one decision is standing. Submit its exact ID and one answer:

```json
{"kind":"item","item":{"id":"item-1"}}
{"kind":"target","target":"self"}
{"kind":"position","position":"help"}
{"kind":"position","position":{"x":42,"y":10}}
{"kind":"confirmation","confirm":false}
{"kind":"choice","choose":[0,2]}
{"kind":"text","text":"Elbereth"}
```

A `position` decision exposes the engine cursor and `mode` (`browse` or `select`).
Answer with a compass direction to move the cursor, `help` for engine instructions,
`finish` to finish at the cursor, or `{x,y}` to select a map square (x 1–79, y 0–20).
These continue the standing map prompt; they are not hero movement operations.
Detection scrolls remain suspended until an explicit finish, selection or cancellation.
The decision and cursor survive close/resume with the pinned runtime.

Choice IDs are the returned **integers**, not keyboard letters. Headers are not
options. Cancellation is `decision.cancel`, not an empty choice array, arbitrary
text, or a confirmation default. It cannot undo time already spent. Wrong
answer shapes and stale IDs do not advance the engine. No client should restart
the initiating action to continue a pending decision.

Use the returned `decision.id` as `decision.answer.params.decisionId` or
`decision.cancel.params.decisionId`; the standing neighborhood
`inputGate.decisionId` matches it. An explicit `confirm:false` answers the
engine's yes/no question; `decision.cancel` cancels the standing decision and
reports `cancelled`. Both preserve any time the initiating operation already
spent. Declining does not request the initiating action again. Observe/replan,
then choose a new operation deliberately; a later reattempt can raise a new
genuine warning with a different ID. Never convert repeated declines or an
unrecognized decision kind into consent.

Confirmation decisions may include `context: {action, direction?, itemId?}`.
These are only fields from the initiating public request, retained across
close/resume. Unspecified directions and name-selected or subsequently selected
item IDs are omitted. Context does not infer a warning reason or promise safety;
`about` preserves the original engine warning. No hidden trap, curse, nutrition
prediction or teleport destination is added. See the explicit decline and
deliberate-reattempt handlers in the [manual reference example](AGENT_BROWSER.md#manual-reference-consumer).

## Responses

Every accepted gameplay operation/answer returns:

- `version:1`, `sessionId`, `requestId`, `revision`;
- `outcome`: action, status, actual `turnsElapsed`, `positionChanged`, effects,
  and an optional reason;
- `observation`: turn, stable level identity, position, named vitals, perceived
  inventory, underfoot items, layered world, recent heard narration, and
  perception freshness;
- `events`: ordered changes from this operation, not a drained global stream;
- `decision`: a typed choice or null;
- `ended` and `end`: an authoritative terminal result or null;
- optional `error`, `storage` and `recording` diagnostics.

Protocol/shape errors can contain only `version` and `error`, without an
observation. New full semantic rejection frames retain the still-standing
engine or item choice when its identity, knowledge and storage state remain
safe; invalid answers do not silently dismiss it. They do not synthesize a
choice for an unloaded world, unknown item knowledge or known failed storage.
A diagnostic requiring resume takes priority over any choice in a previously
recorded frame. Historical receipts—including older error frames—are returned
unchanged, not repaired to look like today's current state. Do not assume an
error means the operation definitely did not execute: `unknown`,
`incompleteRequest` and storage diagnostics require explicit recovery.

[response.schema.json](../protocol/response.schema.json) describes all surfaces,
including discovery and error-only responses. New output properties may be
added within v1; requests remain closed to unknown fields. Clients must not act
on an unknown decision kind or outcome.

### Perception, not omniscience

World cells layer remembered terrain and currently rendered occupants/objects.
For perceived `openDoor` and `closedDoor` terrain, `terrain.orientation` is
`horizontal` (frame runs east–west) or `vertical` (frame runs north–south).
This is the frame/wall axis, not the direction of an open leaf or of travel.
It comes from disclosed engine symbols, including perceived backgrounds beneath
occupants, never unseen map structure or neighboring tiles. It is retained with
terrain memory and omitted when unknown or when the terrain is not an intact
door. Neighborhood and cell-action terrain expose the same orientation.
Optional `cell.visible` reports the engine's current sight of that square.
`false` retains remembered terrain; it does not imply an empty square or
absence of a creature perceived through another sense. Older engine packages
omit this field: clients must not guess visibility from distance or map updates.
Darkness does not erase previously perceived terrain. Undiscovered terrain
remains unknown, including on invisible squares.
`terrain.freshness` in world, neighborhood and cell-action views is `current`
when known terrain is in sight, `remembered` when known but out of sight, and
`unknown` for undisclosed/dark terrain. World `terrain.knowledge` still records
the terrain-memory layer; it is not a visibility test. A known trap is the world
terrain overlay (`type: "trap"`); local views additionally retain a previously
perceived base beneath it and include `hazards: ["trap"]`. Those layers need not
have identical terrain types. Neither layer infers terrain from failed movement.

World, neighborhood and `session.actions` share displayed occupant
`kind`, `appearance`, `mark`, `color` and disclosed `attitude`, plus displayed `objects`. An already
perceived boulder carries `objects[].kind: "boulder"`, independently of any
`movement.intent: "possiblePush"` offer. This does not reveal whether a push will
succeed or what is beyond it. Generic objects have no inferred identity or
category. Optional display fields may be absent on an older pinned package.
The map is not a query of undiscovered level state. Replace the full observation
on each response; never carry future terrain backward through a replay. Labels,
marks and colors are presentation data, not object identity or game rules.

Missing properties are unknown. `inventoryKnown`, `here.known` and
`perception.{inventory,here,equipment}` distinguish current-at-boundary,
last-known and unavailable information. Empty known arrays mean empty; unknown
does not. Existing engine pins can have fewer perception capabilities.

Health/energy/etc. are numeric where the engine supplies numeric values. Some
legacy/formatted vitals can be strings; exceptional strength is not flattened.
`vitals.hunger` is a canonical `HungerState`: `satiated`, `not_hungry`,
`hungry`, `weak`, `fainting`, `fainted`, `starved` or `unknown`.
`vitals.burden` is a `BurdenState`: `unencumbered`, `burdened`, `stressed`,
`strained`, `overtaxed`, `overloaded` or `unknown`. Display padding and case are
normalized; the engine's empty normal labels mean `not_hungry` and
`unencumbered`. Missing perception stays absent and unfamiliar text is `unknown`.
`hungerLabel` and `burdenLabel` preserve the original display strings. The public
types are generated from the response schema. These states disclose no exact
nutrition, prayer timer, piety or undiscovered intrinsic properties.

An operation can spend many turns without another opportunity for input.
`turnsElapsed` reports the complete interval to the returned input boundary,
including sleep or paralysis. Read ordered `heard` and `felt` events to narrate
disclosed loss and recovery of control; the final ready state does not mean the
hero could act during those intervening turns. For example a sleeping-potion
drink can include “You suddenly fall asleep!”, intervening turn events, then
“You wake up.” Do not attribute every long interval to paralysis or infer a
remaining-duration countdown. Multi-turn meals and interruptions retain their
existing authoritative activity events. See [outcomes and safe recovery](SEMANTIC_OUTCOMES.md)
for deliberate waiting, guarded waiting, time spent and uncertain receipts.
`lifeSaved` is a witnessed event, not game over. Only engine terminal facts
establish death, escape or ascent; process failure is never a victory or death.

## Revisions, retries and storage

Every gameplay and decision request requires `requestId` and `expectedRevision`.
Once recorded, the same ID and canonical payload return the original receipt.
Rejections before reservation (for example, `staleRevision`) are not durable
receipts and can be evaluated anew on an explicit caller retry. Do not infer
reservation or authorize an automatic retry from the presence of a request ID.
A changed payload under an already-reserved ID is an error. Known retries are checked **before** stale revisions,
so a successful but timed-out operation remains retrievable. A retry receipt is
historical and must not rewind a newer local observation.

Revision is an interaction boundary, not turn count. A zero-turn choice may or
may not change revision according to whether the core accepted new input.
`session.observe` sends no input, spends no turn, changes no revision and consumes
no events. It does not start or resume an unloaded game.

Native sessions retain validated input journals, semantic metadata, request
reservations, public receipts, and pinned engines. Resume replays the input with
that pin and requires exact prompt/offer agreement before rebinding a pending
choice. Profile 1 records a fixed UTC creation calendar and isolates user
options/configuration; unprofiled history is refused without inventing settings.
See [runtime profiles and replay limits](REPLAY.md). Prompt agreement alone is
not a universal original-world equivalence proof.
An exclusive lease prevents multiple owners. Missing receipts are uncertainty,
not authorization to execute twice. Corrupt or torn history is not automatically
truncated. Closing retires the engine; it does not delete or in-game quit.
Interrupted meals/study return `outcome.status="interrupted"` from actual
engine activity events. Observing, resuming or retrying a receipt never continues
them: issue a new explicit `game.eat`/`game.read` for the remaining perceived
item. A `game.wait` request can be refused near danger; zero elapsed turns with
no progress are `blocked`, not a completed waiting turn or forced consent.

Closing a loaded terminal world succeeds as a no-op if its engine already
retired; it does not restart it or invent a view for an unloaded session.

**Creation is not retry-idempotent.** Do not blindly repeat `session.create`
after losing its response. Lifecycle methods do not share gameplay receipt
semantics. Storage failure does not undo a deed: retain its request ID.

`protocol.describe.capabilities` distinguishes native filesystem/fsync, isolated
WASM memory with no durability, and explicitly requested IndexedDB transactions
with origin Web Lock ownership. WASM resume requires the same package identity.
See [WASM guarantees and tests](WASM.md).

## Limits and framing

Native CLI: one UTF-8 JSON request per LF-terminated line, one JSON response per
line; diagnostics only on stderr. Embedded NUL, malformed UTF-8, duplicate,
escaped, unknown or inapplicable field names are rejected before engine input.
No automatic retry occurs at the transport layer.

Public request frames are capped at 4096 bytes; responses include full
observations and can be larger. The current private semantic operation
storage imposes an additional **4094-byte translated-request limit**; the C core
rejects larger combinations explicitly. Individual limits are in the schemas:
64-byte session/item/decision IDs, 128-byte request IDs/text answers, 127-byte item-name queries,
31-byte identity strings, 64 distinct choice IDs, JavaScript-safe integer guards.
`x-maxBytes` supplements JSON Schema character lengths for UTF-8 byte bounds.

This release does not claim every original NetHack action, arbitrary legacy
historical equivalence, automatic crash recovery, or general power-loss proof.
The protocol stabilizes supported operations without inventing missing behavior.

### Perceived actions and neighborhood (resolver version 1)

`protocol.describe.capabilities.affordanceVersion: 1` describes the library
resolver. Engine support is separate: every newly emitted full observation carries
`neighborhood`, either `available` or `unavailable` with `unsupportedPerception`,
`unknownPosition`, or `recoveryRequired`. Old receipts are returned unchanged and
may omit it. A resumed game uses its original pinned engine/package.

`session.actions({sessionId, expectedRevision, target})` accepts `"here"` or
`{direction: Compass}`. It returns an `ActionsResponse` (`kind: "actions"`), never
an observation. It rejects a stale revision before resolving and never resumes an
unloaded engine. It sends no engine input, consumes no events or random numbers,
reserves no receipt and writes no storage. The SDK's `game.actions()` does not
accept this result as a snapshot or clear an uncertain operation.

Available neighborhoods have a shared `basis: {revision, levelId, origin}`,
`inputGate`, radius 4 and exactly 81 row-major cells, dy/dx -4 through 4. The nine
query targets equal the corresponding neighborhood cells. Playable bounds are
x=1..79, y=0..20; out-of-map entries have no terrain assertion or actions and false
walkability. Swallowing does not invent a surrounding normal map.

`walkable` describes last-known terrain traversal for ordinary locomotion,
including auto-opening a known unlocked door. It is independent of occupants,
hazards, source-dependent movement restrictions, and permission to issue input.
Unknown doors, water/lava and unusual forms return null conservatively. Manual
movement remains available even toward false/null terrain. `movement` describes
an adjacent attempt (including creature/ally bumps or possible pushes), and known
intact-door diagonal restrictions. No success, safety or hidden squeeze test runs.

Door locks come only from player-facing disclosures at the actual engine target.
They are `unknown`, `locked` or `unlocked`, with independent `unknown`, `witnessed`
or `remembered` freshness and an observation turn. Seeing a closed door again
cannot refresh or invalidate remembered lock evidence. An observed replacement or
opening clears obsolete closed-door advice. Tool Lock/Unlock confirmations disclose
knowledge even on decline, but are never answered automatically. Bounded per-level
records are reconstructed by integrity-checked pinned input replay, not hidden save
state. Public `doorWitness` events carry level, coordinates, fact and turn.

Offers use named methods only, with a closed availability union: `attemptable`,
`uncertain`, `needsSelection`, `outOfReach` or `knownBlocked`. The last two carry no
runnable arguments; `knownBlocked` requires a reason. Tool selection uses current
perceived classes, never hidden powers or guessed identity. `context` is explanatory
and must not be passed to `game.apply`; item, direction and confirmation remain
separate genuine decisions. Cost is variable, not a promised turn count.

SDK named methods accept optional `{expectedRevision}` as their final argument.
Copy the offer's basis revision when opening a control; queued operations preserve
that revision and copied arguments. Omitting it retains ordinary sequential input.
The session-wide input gate takes precedence over all offers: a standing decision
allows only its answers/cancellation, and uncertainty requires receipt recovery.

Storage diagnostics always override a historical input gate. A failure while
publishing/checkpointing a completed input can be discovered after its exact
receipt was formed. Preserve that receipt's neighborhood unchanged; do not rewrite
it on the original reply or later retries. A degraded `storage`/`recording` result
blocks new operations regardless of the receipt's old gate. A fresh observe/query
reports the current recovery requirement, and the SDK refuses discovery while it
has an unresolved request.

### Perceived creature appearance

`occupant.appearance` in world, neighborhood and cell-action views, when present, names the monster type
represented by the engine's displayed glyph (for example `kitten` or `newt`). This
is available without spending a turn or attacking. It is an apparent description,
not proof of a shapeshifter's true form, an unseen monster lookup, or an entity ID.
It is omitted during hallucination and by older engine packages. Clients must not
infer it from message prose, symbol/color pairs or remembered occupants. Refresh
it from each observation; absence must clear an earlier description. Saved games
continue to use their pinned package and may lack this optional field.

`game.quit` requests NetHack’s own quit confirmation. Declining keeps the run
active; an explicit affirmative decision answer ends it. Its journal and terminal
state remain available on resume. `session.close` only unloads a session.

The current cell's action offers include item eligibility computed by the same C
candidate resolver used by operations. `knownBlocked` with `noPerceivedItems`
means a client can disable that action without sending input. Unknown or stale
knowledge remains `uncertain`, not a claim that no item exists. Eligibility does
not imply safety: curses, unknown potion effects and warnings remain engine decisions.
`game.drink()` on a perceived fountain or sink underfoot asks the engine's genuine
confirmation even without carried potions. Adjacent water features do not qualify.

Current inventory and underfoot item references include optional `actions`: named
candidate actions computed by the shared C item resolver, using the same perceived
class and equipment accessibility as explicit operations. The list is omitted for
stale perception. It is eligibility, not a safety guarantee or an input gate; clients
must still respect decisions, recovery and the observation revision, and send the
opaque item ID unchanged. No hidden curse, potion effect or corpse safety is exposed.

`game.loot()` opens perceived containers on the current square through NetHack's
loot command. It requires current floor perception and a recognizable container;
it never substitutes an adjacent creature interaction or picks up the container.
Multiple containers, inspection, transfer selection and warnings remain engine
decisions. The neighborhood offers `game.loot` only underfoot;
container appearance does not disclose contents, locks, traps, or magical powers.
Contents become available only through the engine's explicit container choices,
not the ground inventory. Answer those choice IDs, rather than starting a second
operation or reusing ground item IDs for contents.

Container choices carry `containerPhase: "inspect" | "transfer"`. Inspection of
unknown contents is explicit and costs time; known contents open directly into
the transfer decision. Transfer options carry `transfer: "take" | "put"`, authored
by C from the actual object binding. Clients may stage both groups locally and
submit their choice IDs together, including selecting all take options. Each
selection moves the offered whole stack. Taking happens before putting; putting
uses the originally offered amount even if a taken stack merged into it. Original
engine transfer rules, capacity/shop confirmations and interruption apply. This
is one reviewed plan, not an atomic rollback transaction. Cancellation does not
undo inspection or transfers already performed. Unsubmitted UI drafts are not
engine state; resume restores the exact standing decision with no selected items.

### Automatic ground pickup

Creation accepts `automaticPickup`; `game.configurePickup({automaticPickup})`
replaces the complete configuration at a free command boundary. TypeScript uses
`game.configurePickup(settings)`. The C convenience API uses
`nnh_automatic_pickup`, `nnh_identity.automatic_pickup`, and
`nnh_game_configure_pickup`. The object has five required fields:

```json
{"enabled":true,"itemTypes":["gold"],"arrows":true,"leaveCorpses":true,"leaveKnownCursed":true}
```

Types are gold, food, potions, scrolls, weapons, armor, rings, amulets, tools,
spellbooks, wands, gems, rocks, balls and chains. Deliberately select all names
for all categories. An empty array means no categories; C maps it to NetHack's
nonempty venom sentinel, so only an enabled arrow inclusion can collect items.
Off preserves the configured filters. The pixel client defaults to enabled
Gold + arrows; omitted library creation settings leave automatic pickup off,
with gold/arrow filters ready to enable. No client defaults are injected on resume.

The settings arrive before engine game creation and initial pickup. Updates spend
zero turns but advance revision. Both use the input journal, pre-input reservation,
and durable receipts. Read actual active settings from the observation, including
after resume. An outstanding decision must be answered/cancelled before updating.
Never retry an uncertain update with a fresh request ID.

Both native and WASM use POSIX extended regex matching against NetHack's singular
perceived description. Arrow inclusion uses `(^| )arrow( named .*)?$`, corpse
exclusion uses ` corpse( named .*)?$`, and known-curse exclusion uses
`^(an? |the |[0-9]+ )?cursed `. Exclusions are inserted last because the engine
prepends rules and uses the first match. The curse rule only matches disclosed
curse wording, never hidden object flags. Recovery overrides `pickup_thrown`,
`pickup_stolen`, and `nopick_dropped` are deliberately disabled: recovered,
thrown and dropped items follow these same filters. Shop exclusions, weight rules,
engine warnings, and explicit manual pickup remain intact. These settings never
open or transfer a container and offer no arbitrary options or pattern console.

## MCP observation presentation

The C/TS/WASM API and durable receipts retain full observations. WebMCP and both
stdio MCP servers project those responses into the compact envelope defined in
`protocol/mcp-response.schema.json`. Successful calls return `structuredContent`
and an empty `content` array: consumers must read structured results. There is no
second JSON text copy. Errors, decisions, events, outcomes, request IDs, revisions,
and storage/recovery information remain present and are never inferred.

`session.observe` returns the entire current perceived state, including
`observation.neighborhood`, as a standalone snapshot. It requires no baseline,
request ID, or revision guard and spends no turn:

```json
{"name":"session_observe","arguments":{"sessionId":"YOUR_SESSION_ID"}}
```

Read the complete result from `structuredContent`. This includes the full known
map, inventory, vitals, neighborhood/action offers, standing decision, and current
revision; it does not reveal hidden game state. In TypeScript use
`await game.observe()`; in C use `nnh_session_observe(context, session_id, &result)`.

Other MCP observations omit `observation.neighborhood`; use `session.actions` for
the C driver's detailed offers at a target. The next ordinary delta explicitly
removes any neighborhood from a preceding full snapshot, preventing stale offers.
`protocol.describe` retains backend guarantees but
omits the redundant catalog, which MCP tool discovery already supplies.

Each observation response carries `update`:

- `{"kind":"snapshot","id":1}`: replace the whole observation.
- `{"kind":"delta","id":2,"base":1}`: apply only to observation update 1 on
  this connection and session. Replace each supplied observation field in full,
  except `world`, whose cells replace/upsert by `(x,y)`. An omitted field/cell is
  unchanged. `update.remove` deletes named observation fields;
  `update.worldRemoved` deletes `[x,y]` coordinates. Replacement cells can remove
  occupants, objects, or visibility; do not merge their individual properties.

An empty list is a real replacement, not omission. Inventory item IDs remain
opaque. Observation update IDs are connection-local counters, independent of
game revisions and turns. Errors and responses without observations do not
advance them. Top-level fields always describe this response, not a patch.

Create/first observation, session switches, level changes, explicit observe/resume,
and historical receipts with a lower revision produce snapshots. Exact request
retries still use the original full engine receipt, but their presentation may
be a different delta or snapshot. Never use presentation equality to decide
whether an input ran. Historical receipts must not rewind an independent UI.

After lost/out-of-order results or reconnecting, call `session.observe` for a
fresh snapshot. Do not manufacture a new action ID to recover. The exported
`CompactObservationReader` from `neonethack/webmcp` or `neonethack/mcp` materializes
observations and rejects a delta without its baseline. It does not authorize
input, auto-answer warnings, or reconstruct neighborhood offers.

### Perceived attitude and normalized hunger

`occupant.attitude` in world, neighborhood and cell-action views is optional: `hostile`, `peaceful`, or
`tame`. The shared headless engine discloses it only for a currently visible,
spotted, undisguised creature while not hallucinating or swallowed. Omission means
unknown, not hostile. Remembered glyphs and hidden monsters disclose no attitude.
Like appearance, this is a boundary observation rather than persistent identity.

The C semantic driver strips terminal padding from hunger/burden words. A received
blank hunger status means `not_hungry`, as displayed by the engine; an absent
status remains unknown. Clients must not derive numerical nutrition from it.

The [Hero facade](HERO.md) uses these public observations and existing named
operations; it does not extend the request protocol or infer item identities.

## Player-known information and final results

`observation.knowledge` contains engine-disclosed information at `observedTurn`.
Check `observation.perception.knowledge` before treating it as current. It is
omitted when unavailable. Pure observe/actions queries neither refresh engine
knowledge nor consume input or randomness.

- `spells`: known name, level, category, ordinary menu failure percentage and
  rounded retention text. Raw memory counters and unknown spells are absent.
- `skills`: displayed skill rank and advancement state (`available`,
  `needsExperience`, `peaked`, `practice`). No hidden practice counters.
- `levels`: remembered dungeon overview entries with canonical level IDs,
  branch/depth, existing annotation and remembered feature counts. Counts are
  the overview's bounded values: **3 means three or more**. Forgotten levels
  are omitted. This is not the current unseen map or a portal/trap oracle.
- `conduct`: engine counters for food, unvegan, unvegetarian, gnostic,
  weaponHits, kills, literacy, objectPolymorphs, selfPolymorphs, wishes,
  artifactWishes, sokobanViolations and pets.
- `achievements`: engine-issued, non-spoiler achievement names and stable IDs,
  including attained rank titles and final roleplay achievements. Hidden prize
  identities are withheld; this is not the entire interactive chronicle.

Inventory and perceived floor objects have a `known` object. Individual fields
are omitted when unknown: identified `identity`, known `beatitude`, identified
`charges`/`recharges` or `enchantment`, and known `erosionProof`. Hallucination
withholds these properties. Absence of a curse/charge field means unknown, not
uncursed/empty. Nutrition, prayer timers, hidden traps and unseen monster state
are never supplied by this projection or candidate filtering.

`end.score`, when supplied, is the final score calculated by the engine after
its terminal scoring phase, including its real bonuses. No score is synthesized
from turn count or experience. A terminal observation retains the last live
perception plus engine final knowledge; postmortem identification does not leak
back into the live inventory. Repeated queries and exact lost-response retries
retain the same terminal result. Clients can summarize the genuine outcome,
score, achievements, conduct and remembered places without inventing progress.

See [COMMAND_COVERAGE.md](COMMAND_COVERAGE.md) for tested scenarios, intentional
omissions and the distinction between endgame fixtures and a completed run.
