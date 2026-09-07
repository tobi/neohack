# WebMCP

`neonethack/webmcp` registers **every tool in the MCP catalog** with a browser's
native WebMCP implementation. Names, descriptions and input schemas come from the
same browser-safe `neonethack/mcp/tools` module as stdio MCP. There is no generic
`act` operation. New catalog methods automatically appear in both integrations.

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
`unregisterTool`). Browsers without the API return `supported: false`; no shim,
remote MCP service or global JavaScript tool registry is installed.

The current WebMCP interface accepts `readOnlyHint`; the adapter preserves that
hint from MCP. Calls return `structuredContent`, `isError`, and an empty `content` array. Read
[compact observation updates](PROTOCOL.md#mcp-observation-presentation) before
consuming them: ordinary turns carry changed fields/cells, not a full map.
All input arguments, including unknown properties, reach C validation unchanged.
Supplied request IDs, revisions, item IDs and decision answers are never rewritten.
A signal aborted before submission prevents input. Aborting after submission
cannot undo an engine action: the transport still settles the original receipt.

## Pixel client

The fullscreen client registers the complete generated catalog after establishing its
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
a different request cannot bypass them. Old cached receipts retain their original semantics in compact presentation,
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
compare the exact vocabulary across native stdio/HTTP MCP, WebMCP, JavaScript
low/high.low and the webscript loader. Host policy can restrict execution without
changing discovery; the workshop owns creation and restricts access to its run.


Library tests check full catalog parity, unchanged arguments, read-only annotations,
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
