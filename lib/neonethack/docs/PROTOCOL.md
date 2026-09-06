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

## Method families

| Family | Methods |
|---|---|
| Discovery | `protocol.describe` |
| Session | `session.create`, `session.observe`, `session.resume`, `session.close` |
| Movement | `game.move`, `game.wait`, `game.climb` |
| Environment | `game.search`, `game.kick`, `game.open`, `game.close`, `game.pray`, `game.quit` |
| Items | `game.pickup`, `game.eat`, `game.drink`, `game.wield`, `game.equip`, `game.remove`, `game.read`, `game.apply`, `game.drop`, `game.zap` |
| Continuation | `decision.answer`, `decision.cancel` |

There is deliberately no generic `act`, raw key, travel-until-success, or menu
reply method. Inspecting self/here/inventory is a projection of the observation,
not a gameplay action. Unsupported actions are not advertised.

### Targets and items

`move` takes eight compass directions. `climb` takes `up`/`down`.
`kick`/`open`/`close` accept an adjacent `{direction}` target; omitting it offers a
choice. `zap` additionally permits `"self"` and vertical aiming. Applying a tool
accepts an item; tool-specific targets arrive as subsequent decisions.

An item is `{id:"item-..."}` or a perceived-name query. Omission asks for
candidates without an engine turn. No arbitrary first match, slot-letter
fallback, hidden-property filter, or navigation is permitted. Eligibility does
not imply safety. Current-schema quantities are unsupported, not silently
ignored. IDs are opaque and session-scoped.

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
The map is not a query of undiscovered level state. Replace the full observation
on each response; never carry future terrain backward through a replay. Labels,
marks and colors are presentation data, not object identity or game rules.

Missing properties are unknown. `inventoryKnown`, `here.known` and
`perception.{inventory,here,equipment}` distinguish current-at-boundary,
last-known and unavailable information. Empty known arrays mean empty; unknown
does not. Existing engine pins can have fewer perception capabilities.

Health/energy/etc. are numeric where the engine supplies numeric values. Some
legacy/formatted vitals can be strings; exceptional strength is not flattened.
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
storage imposes an additional **1022-byte translated-request limit**; the C core
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

`observation.world[].occupant.appearance`, when present, names the monster type
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
