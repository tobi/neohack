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
hint from MCP. Calls return MCP-style text plus `structuredContent` and `isError`.
All input arguments, including unknown properties, reach C validation unchanged.
Supplied request IDs, revisions, item IDs and decision answers are never rewritten.
A signal aborted before submission prevents input. Aborting after submission
cannot undo an engine action: the transport still settles the original receipt.

## Pixel client

The fullscreen client registers all 26 current tools after establishing its
persistent WASM transport. Open the game menu to see WebMCP availability. Agent
calls and human input share a reservation: concurrent calls receive a busy error
before submission. Close a human menu before agent input. Returned standing
choices appear in the game UI and await an explicit `decision.answer` or
`decision.cancel` from either participant.

Agent-created games appear immediately in the HUD and browser adventure list.
Operations use the same origin-owned IndexedDB journal as human input. Exact
uncertain requests are retained in display metadata as well as the engine store;
a different request cannot bypass them. Old cached receipts are returned intact,
and a free observation keeps the visible world from rewinding. Resume selects the
saved engine package. A query never silently resumes or upgrades another package.
The visible custom element exposes `data-session-id` and `data-revision` for agents
starting with an already open adventure; use `session.observe` for its full frame.

This exposes browser-local capabilities, not an HTTP endpoint or a stdio MCP URL.
The browser mediates agent access. Storage ownership and secure-context checks
remain unchanged. Session creation itself has no request ID; if its reply is lost,
inspect the visible game/adventure list before creating another life.

## Verification

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

## agent-browser

Verified with **agent-browser 0.36.0 + Chrome for Testing 152.0.7977.82** against
the pixel client's HTTPS preview: `webmcp list` discovers all 26 tools;
`webmcp invoke` creates a fresh persistent game and performs a search, advancing
both the engine and visible HUD by one turn. Removing that test interface also
removed all 26 registrations in this browser run.

The CLI supports `webmcp list`, `webmcp invoke`, `webmcp result` and
`webmcp cancel`. It uses Chrome's experimental **CDP WebMCP domain**; Chromium 148
can expose the older page testing API while lacking this domain. Upgrade the
browser as well as the CLI. Managed Chrome enables WebMCP by default. For an
attached, sandboxed browser, enable experimental web platform features when
launching Chrome and pass its CDP port on every command:

```sh
agent-browser --cdp "$CHROME_CDP_PORT" open https://your-preview.example
agent-browser --cdp "$CHROME_CDP_PORT" webmcp list
agent-browser --cdp "$CHROME_CDP_PORT" webmcp invoke neonethack_protocol_describe --params '{}'
agent-browser --cdp "$CHROME_CDP_PORT" webmcp invoke neonethack_game_search --params @search.json
```

`search.json` must contain the actual session ID, latest expected revision and a
unique request ID. Retain that exact file for an uncertain retry. Cancelling a CLI
invocation does not undo engine input already submitted; receipt recovery remains
required. Run probes with a new browser profile, never a player's existing saves.
