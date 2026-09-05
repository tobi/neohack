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
| Environment | `game.search`, `game.kick`, `game.open`, `game.close`, `game.pray` |
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
{"kind":"confirmation","confirm":false}
{"kind":"choice","choose":[0,2]}
{"kind":"text","text":"Elbereth"}
```

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
