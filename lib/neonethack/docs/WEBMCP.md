# WebMCP

`neonethack/webmcp` registers the same navigation tools as native stdio/HTTP
MCP. Names, descriptions and schemas are generated from `protocol/agent.ts`,
with explicit mappings to the low semantic catalog. Use `go` for destinations,
`explore` and `descend` for bounded navigation legs, and `attack` for a
separate deliberate attack. There is no profile switch or generic `act` tool.
The low library, C API and NDJSON retain precise operations.

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
`isError`, and the same result serialized in a text `content` block for older clients. Results contain a brief witnessed
summary and a complete observation; agents do not merge deltas.

Pass the short `sessionId` back on calls. The adapter owns request IDs, its
last observed revision; callers supply the exact returned `decision.id` as
`decisionId` on every `decision_answer` and `decision_cancel`, along with their
chosen answer or confirmation. An old ID is rejected before resolving named
choices or submitting input, even if the new prompt has the same kind or labels.
Closing/resuming the same pending question preserves its ID; a later question
gets a different ID. Invalid or extra arguments
are rejected before dispatch. A stale revision requires observation and a new
judgment, not an automatic retry. Native MCP captures the shared run adapter
revision when a call arrives; it does not track each HTTP client’s last view.
HTTP client metadata does not establish ownership or decision authority.
Decision identity remains explicit across connections and participants.

Choice options include a readable `name` alongside their numeric `id` and
displayed `label`. MCP accepts either names or IDs in `answer.choose`. Names
are aliases scoped to the supplied `decisionId`, not durable identities. An ambiguous
name returns the matching candidates under the same standing decision; select
one by ID. An unknown name returns the available choices. Neither clarification
submits engine input. Item selections continue to use opaque item references.

`retry` resolves a retained uncertain input or reads the most recent completed
input receipt if the reply was lost outside the adapter. The latter is marked
`historical: true` and cannot rewind current state. It never resumes a navigation
leg. `receipt({sessionId, operationId})` retrieves a specified historical receipt.
If other inputs occurred since a lost reply, the most recent receipt may belong
to those inputs; use its operation ID and revision to identify it.

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
standing decisions so another tab can resume it. If another tab is actively
playing, close that tab or use **Save & return to doorway** there before resuming
here. Do not clear site data to resolve ownership.

Agent-created games appear immediately in the HUD and browser adventure list.
Operations use the same origin-owned IndexedDB journal as human input. Exact
uncertain requests are retained in display metadata as well as the engine store;
a different request cannot bypass them. Historical receipts retain their original semantics,
and a free observation keeps the visible world from rewinding. Resume selects the
saved engine package. A query never silently resumes or upgrades another package.
The visible custom element exposes `data-session-id` and `data-revision` for agents
starting with an already open adventure; use `session.observe` for its full frame.

This exposes browser-local capabilities, not an HTTP endpoint or a stdio MCP URL.
The browser mediates agent access. Storage ownership and secure-context checks
remain unchanged. Session creation itself has no request ID; if its reply is lost,
inspect the visible game/adventure list before creating another life.

## Verification

Run `npm run --prefix lib/neonethack check:tools` from the repository root to
check navigation catalog agreement across native stdio/HTTP MCP and WebMCP,
and explicit coverage of low operations through JavaScript low/high.low and the
webscript loader. Host policy can restrict execution without
changing discovery; the workshop owns creation and restricts access to its run.


Library tests check mapped operation coverage, adapter-owned guards, read-only annotations,
pre-submission cancellation, failed registration cleanup and unavailable browsers.
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
