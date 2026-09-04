# neonethack — bun front

Serves `client/` and bridges browser WebSocket ↔ engine child-process stdio.

## Setup

```sh
cd bun_server
bun install
bun run dev
```

Open http://localhost:3000. Override defaults with env:

```sh
PORT=3000 ENGINE_CMD="../upstream/playground/nethack" \
  SESSIONS_DIR="../sessions" CLIENT_DIR="../client" bun run dev
```

`ENGINE_CMD` is split on spaces; point it at any NDJSON-stdio program
(e.g. `cat` echoes stdin back as a smoke test) until the native daemon exists.

## Routes

- `GET /` (and any static file) → `client/` files.
- `POST /api/session` → `{ "sessionId": "s-..." }`.
- `WS /ws` — JSON messages (see below).

## WS protocol (browser ↔ server)

Browser → server:

- `{ "type": "new", "sessionId": "<id>" }` — spawn a fresh engine.
- `{ "type": "resume", "sessionId": "<id>" }` — spawn a fresh engine and
  replay the stored input log (see Resume flow).
- `{ "type": "input", "sessionId": "<id>", "line": "<NDJSON line>" }` —
  append `line` to the session log, forward to engine stdin.
- `{ "type": "persist_put" | "persist_get" | "persist_list", "sessionId": "<id>", ... }`
- `{ "type": "shutdown", "sessionId": "<id>" }` — kill the engine.

Server → browser:

- `{ "type": "session", "sessionId", "resumed": bool, "replaying": bool }`
- `{ "type": "engine", "sessionId", "line": "<engine stdout line>" }`
- `{ "type": "engine_log", "sessionId", "text": "<engine stderr chunk>" }`
- `{ "type": "replay_done", "sessionId", ... }` — resume log exhausted, now live.
- `{ "type": "persist_result", "sessionId", ... }`
- `{ "type": "session_ended", "sessionId" }` / `{ "type": "error", ... }`

## Sessions on disk

`sessions/<id>/input.log.jsonl` (every browser input line, appended) and
`sessions/<id>/blobs/<key>` (persist_* blobs, base64 on the wire, raw bytes
on disk). Engine-initiated `persist_put/get/list` JSON-RPC requests
(with `id`) are answered by the server from disk and never reach the browser.

## Resume flow

1. `resume` spawns a fresh engine for `<id>`.
2. The stored `input.log.jsonl` becomes the replay queue.
3. Each engine stdout line tested by `isInputRequest()` (see
   `src/protocol.ts`): if it is an input request and the queue is non-empty,
   the next stored line is written to engine stdin instead of going live.
4. When the queue is exhausted (or the engine never emits input requests —
   300 ms fallback flushes the log as plain stdin), the server sends
   `replay_done` and the session is live: further input requests stream to
   the browser as `{ "type": "engine", ... }` lines.
