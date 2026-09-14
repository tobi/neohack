# WebMCP

`neonethack/webmcp` registers the same eleven intention families as Bun/WASM stdio/HTTP
MCP. Names, descriptions and schemas are generated from `protocol/agent.ts`,
with explicit mappings to the low semantic catalog. This guide describes the
current source contract; check the build's generated schemas for
availability. Use `travel mode step` for one adjacent attempt and `travel mode to` for destinations,
`travel mode explore` and `travel mode descend` for bounded navigation legs, and `interact action attack` for a
separate deliberate attack. There is no profile switch or generic `act` tool.
The low library, C API and NDJSON retain precise operations.

Actionless `use` and `interact` are free discovery, even with one offer. Explicit
action executes; no operation is inferred from an item label or a unique match.
See [the family guide](AGENT_PLAY.md) for syntax. Readonly connections advertise
query-only variants of mixed families and reject mutating variants before input;
do not treat a whole family as readonly because it offers discovery.

```ts
import { registerWebMcp } from 'neonethack/webmcp';

// The application owns this public Transport, storage and input serialization.
const registration = await registerWebMcp(transport);
console.log(registration.supported, registration.toolCount);
// On application teardown, unregister only this registration's tools.
registration.dispose();
```

The adapter detects current `document.modelContext` and early
`navigator.modelContext` implementations. It awaits registration, rolls back on a
partial failure, and unregisters via the registration AbortSignal (or legacy
`unregisterTool` or returned cleanup callback). Browsers without the API return `supported: false`; no shim,
remote MCP service or global JavaScript tool registry is installed.

The adapter preserves `readOnlyHint`. Calls return `structuredContent`,
`isError` and the same result serialized in a text `content` block. Game-scoped
results use the shared [DecisionFrame](PROTOCOL.md#mcp-observation-presentation):
basis, gate, actual outcome, scene snapshot, nested decision reply/cancel, fresh
events, query result, structured error and diagnostics. Routine scenes are
compact and complete for the next decision; `observe` adds full `scene.world`.
No legacy top-level state/observation/messages/context/reply fields. Default
snapshots need no delta baseline; optional programmatic encoding is described
in the frame contract.

Pass `basis.sessionId` and the explicit `basis.viewId` on mutations against
the view you read. Lifecycle calls (`session action create`, `session action resume`, `session action suspend`) need no prior
gameplay view. The adapter owns engine request
IDs and revision plumbing, not permission to refresh a caller's stale target.
`respond action answer` and `respond action cancel` instead require the exact returned `decision.id`.
The standing `decision.reply.arguments`, `decision.reply.valueSchema` and
permitted `decision.cancel` supply executable syntax on first presentation.
Choose the value explicitly; old IDs reject before resolving choices or input,
even when a newer prompt has the same labels. Closing/resuming the same pending
question preserves its ID; later question instances get different IDs.

Targets use declared subsets of `{direction}`, `{position:{x,y}}`, `{ref}`
and `{symbol,scope:'adjacent'|'level'}`; here/self is
`{direction:'self'}` where applicable. Item actions retain opaque `itemId`
and optional quantity. Decision values follow their contextual schema rather
than the operation target grammar. Missing or ambiguous symbol matches submit
nothing. Invalid/extra arguments and stale views require correction or fresh
judgment, never an automatic retry. HTTP metadata establishes neither ownership
nor decision authority.

Choice options include a readable `name` alongside their numeric `id` and
displayed `label`. MCP accepts either names or IDs in `value`. Names
are aliases scoped to the supplied `decisionId`, not durable identities. An ambiguous
name returns the matching candidates under the same standing decision; select
one by ID. An unknown name returns the available choices. Neither clarification
submits engine input. Item selections continue to use opaque item references.

Normal navigation stops need no recovery call. Read the returned scene and choose
the next action. There is no `recover` tool.

After uncertain execution or a lost reply, call `observe({sessionId})`. It looks up any retained
uncertain operation by its exact receipt ID, then reads a fresh current scene.
It never resends gameplay or continues a navigation leg. A verified completion is
reported as verification query data with its operation ID and outcome; the
frame's basis, scene and decision describe the current view. An unavailable or mismatched
receipt leaves input blocked and provides a `session action resume` instruction. A dead worker or
storage fault may require reopening the transport first. Repeated observation does
not manufacture missing consent or clear an unverified request.

`observe({sessionId, operationId})` is a diagnostic query. Its historical snapshot
is nested in query `result`, not substituted for the current scene or decision;
old questions carry no executable answer/cancel suggestions. The low-level exact receipt is unchanged.
If an outer bridge loses the entire reply, the adapter may not know which reply
the caller missed. `observe` returns current state instead of guessing the latest
historical operation. Retain bridge invocation IDs for exact correlation.

A signal aborted before submission prevents input. Aborting after submission
cannot undo an engine action: the transport still settles the original receipt.

## Pixel client

The fullscreen client registers the generated navigation tools after establishing its
persistent WASM transport. Open the game menu to see WebMCP availability. Agent
calls and human input share a reservation: concurrent calls receive a busy error
before submission. Close a human menu before agent input. Returned standing
choices appear in the game UI and await an explicit `decision.answer` or
`decision.cancel` from either participant.

Idle title screens release their WASM transport after discovery, rejected starts
and `session.close`. Closing an adventure preserves its unfinished status and
standing decisions so another tab can resume it. Different adventures use separate
stores. Opening the same adventure requests a cooperative handoff: the old tab
finishes accepted input and releases its engine, then the new tab resumes the
same journal and question. A non-cooperating owner times out without changing
the save. Do not clear site data to resolve ownership.

Agent-created games appear immediately in the HUD and browser adventure list.
Operations use the same origin-owned IndexedDB journal as human input. Exact
uncertain requests are retained in display metadata as well as the engine store;
a different request cannot bypass them. Historical receipts retain their original semantics,
and a free observation keeps the visible world from rewinding. Resume selects the
saved engine package. A query never silently resumes or upgrades another package.
The visible custom element exposes `data-session-id` and `data-revision` for agents
starting with an already open adventure; use `observe` to obtain its current DecisionFrame and view ID.

This exposes browser-local capabilities, not an HTTP endpoint or a stdio MCP URL.
The browser mediates agent access. Storage ownership and secure-context checks
remain unchanged. Session creation itself has no request ID; if its reply is lost,
inspect the visible game/adventure list before creating another life.

## Verification

Run `npm run --prefix lib/neonethack check:tools` from the repository root to
check navigation catalog agreement across Bun/WASM stdio/HTTP MCP and WebMCP,
and explicit coverage of low operations through JavaScript low/high.low and the
webscript loader. Host policy can restrict execution without
changing discovery; the workshop owns creation and restricts access to its run.


Library tests check mapped operation coverage, adapter-owned guards, read-only annotations,
pre-submission cancellation, failed registration cleanup and unavailable browsers.
These existing test areas are regression obligations for the redesign, not a
claim that every new DecisionFrame scenario has passed. Validate view-bound
rejections, ambiguous symbols, first-contact reply syntax, scene completeness,
zero-turn decisions and lost-receipt recovery across the shared transports.
The pixel browser suite uses sandboxed Chromium's real native WebMCP registry and
`modelContextTesting` interface with experimental web platform features enabled.
It exercises actual persistent WASM creation, queries, warnings, typed answers,
revision rejection, old receipts, lost-response recovery, close/resume and teardown.
Experimental flags are for this test browser; the application never disables the
browser sandbox or weakens storage guarantees.

API reference: <https://webmachinelearning.github.io/webmcp/>

### Early Chromium cleanup limitation

Chromium 148 can retain native tool descriptors after garbage collection because
its `registerTool` implementation discards the abort-algorithm handle. The adapter
still aborts its registration and every retained callback rejects before input.
Leaving the document clears its registry. Current-spec AbortSignal cleanup and
legacy explicit `unregisterTool` are covered by adapter tests; native tests also
verify that disposed callbacks cannot reach the closed engine.

## Play with agent-browser

Follow [the agent-browser walkthrough](AGENT_BROWSER.md) to discover tools, create
a game, take turns, answer decisions and resume browser saves through WebMCP.

### Earlier clients

Native HTTP accepts the 2025-03-26, 2025-06-18 and 2025-11-25 Streamable HTTP
handshakes alongside 2026-07-28 per-request metadata. Earlier clients send
`initialize`, then `notifications/initialized`, then the negotiated
`MCP-Protocol-Version` header. No transport session is assigned; the short game
session token remains an explicit tool argument. GET streams are not offered.
Missing version headers use the 2025-03-26 default. Modern requests retain their
required metadata and routing-header checks. Earlier tool results include text
as well as structured content. The retired 2024 HTTP+SSE transport is not supported.

WebMCP accepts both document and earlier navigator registration surfaces, including
synchronous registration, explicit unregister methods and returned cleanup
callbacks. It never uses `clearContext` to erase other scripts’ tools.

## Shared scene without extra gameplay

The shared adapter derives `scene.self`, nearby attempts, entities, features,
inventory, underfoot knowledge, automatic pickup, perception and map from C
perceived state. Free enrichment consumes neither turns nor randomness and
never answers a question. Unavailable enrichment must remain visibly unavailable;
it cannot change a saved outcome or silently adopt a newer input basis.

Fresh `events` belong to the call. Navigation may aggregate confirmed substeps;
response-boundary turn labels do not identify every internal event's turn.
Rolling narration and historical receipt events must not become fresh events
on sync. All transports share this projection and its integrity boundaries.

The live input basis remains authoritative while the human display catches up.
Read queries preserve open panels, selections and focus. Human takeover stops
future leg steps, settles accepted input and transfers control deliberately.
An aborted invocation cannot undo input or erase its operation identity.
Ownership loss blocks further input instead of forking the save.
