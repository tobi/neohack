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

Numeric vitals are numbers when supported; strength can have an exceptional
value such as `18/02`. Treat unknown information as unknown, not zero.

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

Do not append the complete recent-heard list after every action: it repeats old
messages. The page uses action events during live play and the checkpoint's
historical heard list when seeking through a recording.

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
{ replyTo: decision.id, choose: ['option-id'] }
{ replyTo: decision.id, text: 'An actual name' }
{ replyTo: decision.id, cancel: true }
```

Use the offered decision kind and limits. Inventory letters and raw command
indices are not public controls. A target is not speech. Eligibility does not
imply that an item is safe to consume. Confirmations require a real user choice.

## Reusable 3D component

```js
import './nh-map3d.js';
const map = document.createElement('nh-map3d');
map.style.height = '500px';
map.observation = response.observation;
map.worldKey = response.sessionId; // scope level IDs and reset framing between worlds
map.addEventListener('tile-select', ({ detail: cell }) => inspectCell(cell));
document.body.append(map);
```

Properties: `observation`, `worldKey` (optional world identity), `selected`, `follow`, `cutaway`, `labels`,
`animateMoves`. Methods: `fit()`, `focusSelf()`, `rotate()`, `tileAt(x,y)`,
`debug()`. Events: `tile-select`, `view-follow`, `renderer-error`.
The renderer makes no game requests. Set `animateMoves=false` for arbitrary
replay seeking so a jump does not depict a fictitious walk through the dungeon.

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
