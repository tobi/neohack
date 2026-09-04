# neonethack Protocol v0.1

Status: implemented and verified. This document describes what the headless
engine (`upstream/win/headless/`) actually does. Golden byte-vectors live in
`vectors/` (regenerate with `vectors/generate.py`, check with
`test/test_vectors.py`). When this file and the engine disagree, the engine
wins and this file is a bug.

## 1. Framing

- One JSON-RPC 2.0 object per line, UTF-8, `\n`-terminated (NDJSON).
- stdout carries engine output only. On startup the port dups fd 1 aside and
  repoints fd 1 at stderr, so even a rogue core `printf` or Lua `print` can
  never corrupt the stream. All diagnostics go to stderr.
- Max 16 MiB per line. An over-long line is dropped and reads as EOF
  (the session ends; see §7).
- Requests have `"id"` (int) + `"method"`; notifications have `"method"` and
  NO `"id"`; responses have `"id"` + `"result"` or `"error"`.

## 2. Startup handshake (one game per process)

One OS process = at most one session = at most one game. The engine blocks
reading stdin before doing anything else:

```
client ──► {"jsonrpc":"2.0","id":1,"method":"initialize",
             "params":{"protocolVersion":"0.1"}}
engine ──► {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"0.1",
             "engineVersion":"5.0.0-0",
             "capabilities":["snapshot","delta","persist","resume-log","seed"]}}
client ──► {"jsonrpc":"2.0","id":2,"method":"new_game",
             "params":{"role":1,"race":0,"gender":0,"align":1,
                       "name":"smoke","seed":4242}}
engine ──► {"jsonrpc":"2.0","id":2,"result":{"sessionId":1,"seedUsed":4242}}
```

- `initialize` MUST come first. `protocolVersion` must start with `"0."`,
  else reply `-32001/nginx "E_UNSUPPORTED_VERSION: want 0.x"` and keep waiting.
- Any other method before the handshake completes gets `-32601
  "expect initialize then new_game"` and the engine keeps waiting.
  Unparseable lines (no method) are ignored; EOF aborts startup silently.
- `new_game` params are all optional: integer role/race/gender/align indices
  (`-1` or absent = ask the player through normal menu prompts later),
  `name` (empty = ask via `getlin`, then OS login fallback), `seed`
  (int or null = OS entropy).
- On `seed`, the port **re-seeds both RNGs deterministically** before any
  game RNG is consumed, and disables later reseeds. Same binary + same seed
  + same inputs + same playground files = byte-identical output (verified by
  `test_vectors.py`). Without seed, play uses OS entropy as usual.
- There is no `load_game` engine method and no second opener: after the game
  starts, the only client→engine lines the engine reads are input responses
  (next section). Resume-from-log is a *supervisor* procedure (§6), not an
  engine method.

## 3. Engine → client notifications

`window_create {window, type}` / `window_destroy {window}` /
`window_clear {window}` / `window_display {window, blocking}` —
window ids are small ints; map type is 3 (`NHW_MAP`). A blocking display is
always followed by an `ack` input request; ack it immediately, no dialog.

`message {channel, window, attr, text}` — `channel` is `"message"` for the
message window, `"text"` otherwise (including `raw_print`). The port also
keeps a 256-line history ring that feeds save/restore (`getmsghistory`).

`cursor {window, x, y}` / `cliparound {x, y}` / `bell` / `delay` /
`number_pad {state}` / `positionbar {text}` / `preference {pref}` /
`display_file {name, complain}` (content lives in the playground's data
files; the reference client logs the name and acks) /
`inventory {perm}` (hint only; real inventory arrives as menus).

`status_init` / `status_enablefield {field, name, format, enable}` /
`status_update {field, value|condition, change, percent, color, colormask?}` —
`field` is the `BL_*` index from `include/botl.h` (0 title … 26 vers,
-1 flush = end-of-cycle trigger, -2 reset). All fields carry strings
**except** `BL_CONDITION` (22), which carries the dereferenced condition
bitmask as `condition` (the core passes a pointer; the port dereferences it —
serializing the address would leak ASLR and break determinism).
`BL_GOLD` (10) carries just the amount (`"1781"`): the core prefixes
`"$:"` or a tty `\GXXXXNNNN:` glyph escape and the port strips everything
through the first `:` (per the `BL_GOLD` contract in `src/botl.c`).

`menu_start {window, behavior}` / `menu_item {window, index, accel,
groupacc, attr, color, text, itemflags, glyph?}` / `menu_end {window,
prompt}` — items precede the pick request; picks are **ordinal indices**,
never pointers (the port keeps the `ANY_P`s).

`snap
...[truncated 3881 chars]