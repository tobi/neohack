# Explorer browser API

The browser is a thin view over the C explorer contract in `API_DESING.md`.
Do not use legacy `{move}`, `{key}`, or `awaiting` payloads.

## World transport

```js
import { World } from './world.js';
const world = new World(''); // same-origin /mcp
const started = await world.stepIn({
  seed: 42, name: 'Explorer', role: 'valkyrie', race: 'dwarf',
  gender: 'female', align: 'lawful'
});
const next = await world.deed(started.sessionId, {
  requestId: crypto.randomUUID(), expectedRevision: started.revision,
  action: 'move', direction: 'south'
});
// Render next.observation; display next.events; handle next.decision.
```

Methods: `stepIn(identity)`, `look(sessionId)`, `deed(sessionId, intent)`,
`reenter(sessionId)`, `leave(sessionId)`, and `tool(name, args)`.

Transport errors reject. Semantic rejections are returned as complete envelopes
with `error`, and often a usable observation/decision; inspect them explicitly.
The transport never blindly retries an action after connection failure.

A live run has one bridge owner. Another bridge's `resume` returns
`sessionBusy` rather than rebuilding that owner's world; reviewing the public
recording remains read-only and available. After the owner leaves, resume
reloads the current revision and pending decision from disk. `sessionBusy` can
also occur briefly after a bridge crash while its engine finishes exiting;
that ownership is not stolen or bypassed.

Request ids are durably reserved before execution. Exact completed retries use
the original receipt, including receipts older than the 64-entry hot cache.
`incompleteRequest` means an id was reserved but no complete receipt can be
recovered: inspect the resumed world, and **do not automatically repeat the
intent with a new request id**. A corrupt request journal blocks new actions
with `storageError` until it is repaired.

## Responses

- `sessionId`, `requestId`, `revision` identify the world and interaction.
- `outcome`: action, status, turns elapsed, whether position changed, effects,
  and an optional reason. A zero-turn action is not necessarily movement failure.
- `observation`: turn, location, you, named vitals, known inventory, layered
  world cells, recent heard sayings, and available underfoot knowledge.
- `events`: ordered public events for this boundary, using `type` (not `t`).
- `decision`: a typed decision or null.
- `ended` and optional `end`: terminal/disconnection information.
- Optional `recording`: current storage health, independent of the immutable
  deed receipt. `status:"degraded"` requires attention/resume; do not repeat the
  deed under a new request ID. See [recording recovery](../docs/RECORDING_RECOVERY.md).
- Optional `storage`: private metadata/input-journal health. Degraded storage
  blocks new deeds/answers; it is preserved across review/live transitions.
  `recoveryRequired` means a semantic boundary could not be established safely,
  not permission to drop the journal or guess the next answer.

Numeric vitals are numbers when supported; strength can have an exceptional
value such as `18/02`. Treat unknown information as unknown, not zero.

`observation.perception` reports the engine snapshot version and freshness of
`inventory`, `here`, and `equipment`: `current`, `lastKnown`, or `unknown`.
"Current" is relative to that returned/recorded boundary, never a wall-clock
promise. An engine input invalidates freshness until a new perception arrives;
older rest-only pins can therefore have last-known belongings at a question.
Existing recordings without this metadata have unspecified freshness, not an
implicit current/empty state. Terminal gameplay perceptions remain frozen.

New engines provide inventory-item `usage` arrays for physical equipment
assignments (`worn`, `wielded`, `offhand`, `alternate`, `quivered`, `attached`).
Do not derive them from item names, and do not infer hidden powers or charges.

### World cells

Cells have x/y, remembered terrain, and optional occupant/objects. Self is
`occupant.kind === 'self'`; allies are separate from creatures. An occupant
must not replace the known ground beneath it. Creature does not mean hostile.
Never derive unseen terrain, object properties, or relationships from symbols.

### Events

| type | Fields | Use |
|---|---|---|
| saw | x, y, kind, mark, color | Perceived visual change; full observation remains authoritative. |
| felt | sense, value | A vital changed; use final observation for typed current values. |
| heard | text | Add narration to the journal. |
| shown | about, items | Display a non-blocking list. |
| ended | kind, cause, turn | Engine-issued terminal facts. |
| actionResult | action, status, turn | Engine-issued activity result (currently normal meals). |

Do not append the complete recent-heard list after every action: it repeats old
messages. The page uses action events during live play and the checkpoint's
historical heard list when seeking through a recording.

## Inspection panels

`<nh-inspection>` is a pure Lit view of a supplied observation and `target`
(`self`, `here`, or a tile coordinate). It makes no transport calls. The shell
uses the named zero-turn `inspect` action when live and ready; during a decision,
in-flight action, or replay it reads already-returned data only. Recorded
inspection never starts an engine or answers a historical question.

Self inspection shows reported vitals, conditions and engine-reported equipment
assignments. Here follows the explorer and uses only `observation.here`; unknown
floor contents are not an empty square. Remote tile inspection uses only map
sightings, never underfoot contents from another square. Tile anchors retain
coordinates, not old cell objects, and are cleared across worlds/levels.
Backward seeks recompute everything from the selected checkpoint. Inspection
pauses replay and cancels a pending seek; late imports cannot replace Live.
Keyboard focus stays out of game shortcuts, and closing an inspector cannot
answer a pending decision—even if Escape is held down.

## Witnessed survival and occupations

`lifeSaved {cause, turn, health}` is an engine-issued public event for an actual
averted death. Cause is coarse (`choking` or `fatal harm`), not a post-mortem
killer description that could identify an unseen attacker or unknown object.
It is not a terminal result and does not imply future immunity.
The returned observation still describes the latest boundary, including the
consumed amulet and any later effects. “You die...” narration alone cannot end
the world. Older pins may survive without reporting this additive event; no
rescue fact is inferred or inserted into their original recordings.

Normal spellbook study now reports `actionResult` completion/interruption from
the engine's actual occupation. An interrupted read is `outcome.status:
"interrupted"`, not an invented completion. Inspection/resume/retry does not
restart it. A fresh read intent may require another real confirmation, and
actual elapsed turns come from the engine. This is specific coverage, not a
claim that every occupation emits these facts.

## Named actions and decisions

Examples:

```js
{ action: 'eat' } // ask the core for perceived candidates
{ action: 'eat', item: { id: 'item-36' } }
{ action: 'kick', target: { direction: 'south' } }
{ action: 'zap', item: 'wand of healing', target: 'self' }
{ action: 'inspect', target: 'here' }
{ action: 'climb', direction: 'down' }
{ replyTo: decision.id, item: { id: selected.id } }
{ replyTo: decision.id, target: 'self' }
{ replyTo: decision.id, confirm: false }
{ replyTo: decision.id, choose: [selected.id] } // returned integer choice IDs
{ replyTo: decision.id, text: 'An actual name' }
{ replyTo: decision.id, cancel: true }
```

Choice option IDs are integers; send the returned IDs unchanged, without deriving
IDs from list positions or labels. Multi-selection requires at least one choice;
use explicit `cancel:true` for none. Item-reference IDs remain opaque strings.
Older recorded/cached receipts keep their original representation; a zero-input
`get_state` returns the current standing offer without rewriting the receipt.

Pickup selects only perceived floor objects. New engine pins bind menu rows to
object identities even when rows have no accelerators, are sorted, or have
identical display labels. An older pin without bindings returns
`itemMappingUnavailable` for targeted menu pickup rather than guessing another
object. Saved pins are not automatically upgraded.

Equipment actions use reported class and current physical `usage`, not item
labels. `equip`/`wear` offer unworn armor, rings and amulets; `remove`/`takeoff`
offer worn eligible items. Accessory removal cannot substitute armor, and
covered armor cannot substitute its outer layer. The engine supplies physical
armor-access facts without disclosing curse state. Older pins with uncertain
physical use/layering fail closed rather than guessing. Body armor can require
several actual turns; do not repeat an intent to finish it. Ring placement
choices are labeled Left/Right; submit their returned integer IDs.

Use the offered decision kind and limits. Inventory letters and raw command
indices are not public controls. A target is not speech. Eligibility does not
imply that an item is safe to consume. Confirmations require a real user choice.

## Reusable 3D component

```js
// Run `bun run build:component`, then serve/copy client/dist/standalone/.
import './dist/standalone/nh-map3d.js';
const map = document.createElement('nh-map3d');
map.style.height = '500px';
map.observation = response.observation;
map.worldKey = response.sessionId; // scope level IDs and reset framing between worlds
map.addEventListener('tile-select', ({ detail: cell }) => inspectCell(cell));
document.body.append(map);
```

Properties: `observation`, `worldKey` (optional world identity), `selected`, `follow`, `cutaway`, `labels`,
`animateMoves`. Methods: `fit()`, `focusSelf()`, `rotate()`, `tileAt(clientX,clientY)`,
`inspectAt(tileX,tileY)`, `show2D()`, `retry3D()`, `debug()`.
Events: `tile-select` (the original supplied cell), `view-follow`,
`renderer-error`, `renderer-state` (`empty`, `initializing`, `ready`, `lost`,
`failed`, `2d`, `limited`, or `detached`). `retry3D()` reports initialization
success; an actual GPU draw can still fail later and emit a renderer error.

The single ESM bundle includes Lit, Three.js, styles and procedural assets; no
application shell, engine, fetch, WebSocket or CDN is required. `demo.html`,
README and dependency licenses accompany the build. The private CI workflow
publishes it as the `nh-map3d` artifact after the browser lifecycle test passes.
No additional license for project source is implied. The first custom-element
registration wins; repeated imports export that same constructor. Do not mix
bundle versions within one document.

WebGL loss immediately exposes the 2D grid; restoration rebuilds resources
from the **latest** observation. Explicit 2D mode survives detach/reconnect and
releases its GPU context. Retry, failed initialization, draw exceptions and
removal clean up controls, observers, textures and geometry. Rendering is
on-demand and stops while hidden, off-screen, in 2D or settled. Reduced-motion
preferences snap transitions. Level/world changes also snap rather than
inventing a walk. Set `animateMoves=false` for arbitrary replay seeking.

Focused arrows navigate an inspection cursor, Enter/Space inspect, Home/End
and Page Up/Down navigate the bounded 2D window, and Escape leaves map focus.
A host with global game shortcuts must ignore the map's composed event path;
selection is never implicit movement or an answer to a game decision.

Display bounds: 20,000 cells, integer coordinates within ±10,000, and 512
combined detailed terrain/actor/object cells. Complex scenes use the 2D grid
instead of allocating unbounded models. Its 80×24-cell window remains
keyboard-navigable across larger maps. Invalid/duplicate/excess entries have a
visible notice. Only the top object is modeled; the selection event retains
all supplied objects. Figures are symbolic, not hidden stats or actual worn
equipment. These are presentation bounds, not engine rules or a complete
recording-schema validator.

## Read-only archive endpoints

- `GET /runs`: run summaries, including whether an event recording exists.
- `GET /runs/:id/index`: ordered frame sequence, offsets, turns, revisions.
- `GET /runs/:id/frames?from=0&limit=20`: a page of perception frames (limit 1–100).
- `GET /runs/:id/export`: download the complete NDJSON recording.

The archive implementation does not import the engine bridge. IDs and paths
are validated. These routes do not mutate worlds.

## Explicit legacy reconstruction

`POST /runs/:id/reconstruct` with `{confirm:true}` starts an isolated worker;
`GET /reconstructions/:jobId` reads its status. This management operation is
separate from read-only playback and from the live bridge queue. It requires a
source engine, static data, a seeded input log, and a working Linux sandbox.
There is no automatic or unsandboxed fallback.

Derived frames carry `response.provenance.kind === 'reconstruction'`, an
unverified/read-only label, fingerprints, and input counts. Display that
provenance on replay and import; never promote the archive into a live world.
See [docs/RECONSTRUCTION.md](../docs/RECONSTRUCTION.md).

## Recording format v1

Each NDJSON line is:

```json
{
  "format": "neonethack.perception",
  "version": 1,
  "sequence": 0,
  "recordedAt": 1788480000000,
  "request": {"tool":"act","action":"wait"},
  "response": {"observation":{},"events":[],"decision":null}
}
```

The response above is abbreviated; recordings contain the full actual response.
Sequences are contiguous and start at zero. Every frame is an independent full
checkpoint plus events; a consumer can seek directly without replaying engine
commands or accumulating future-map artifacts.

Damaged remote archives expose only a validated prefix and an `integrity`
notice. Export includes a `neonethack.recordingManifest` v1 header when needed;
`parseRecording` preserves it as the returned array's non-enumerable `integrity`
property, which `LocalRecording` retains. `gapBefore` frame markers survive
export/import too. Raw originals can be downloaded explicitly with `?raw=1`;
GET never repairs or truncates source files.

`recording.js` exports `parseRecording`, `validateFrame`, `observationAt`,
`LocalRecording`, and `RemoteRecording`. Imported input logs and unsupported
versions fail explicitly. Recorded decisions are displayed read-only.

## Deployment boundary

By default the server listens on loopback. Unexpected Host names are rejected
to prevent simple DNS rebinding. Cross-origin MCP requests are denied unless
their origin is explicitly allowed via `MCP_ALLOWED_ORIGINS`; configured
reverse-proxy origins also authorize their Host names. This is not
multi-user authentication. Only expose the service inside a trusted environment
until authentication and per-run authorization are implemented.
