# neonethack Protocol v0.1

Status: implemented, with current semantic regressions and documented limits.
This describes the raw headless engine boundary, not the public named-action
API. Historical byte-vectors in `vectors/` require a separate conformance audit;
do not blindly regenerate them to match a changed implementation. Prefer
`API_DESING.md` for client-facing tools.

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

`perception {perceptionVersion?, branch, level, x, y, inventory, floorKnown, floor, hereCmap?}` —
non-mutating perceived belongings and current-square context at each semantic
input boundary (including menus and questions, not just resting commands). This
captures changes already made before a mid-deed warning, such as a bitten ration. Objects carry stable internal identities, perceived labels, classes,
and quantities. Version 2 adds carried-item `usage` arrays containing only known
physical assignments: `worn`, `wielded`, `offhand`, `alternate`, `quivered`, and
`attached`. Empty arrays mean none of these assignments; absence means they
were not captured. Artifact powers, charges, BUC and hidden properties are not
exported by this field. Unknown floor contents are not obtained by pickup or touch.
`hereCmap`, when present, is the visible terrain under the hero glyph, rendered
by the engine's own terrain function only when the square is in sight and the
floor is observable. It does not reveal unseen traps or secret terrain. When
blind, no fresh underfoot terrain is supplied; previously remembered terrain
may remain in the semantic observation. This preserves known stairs when a
level is redrawn on return.

`action_result {action, status, turn}` — engine-issued activity completion or
interruption. Currently normal meals emit `eat` with `completed` after consumption
or `interrupted` when an active meal is reset. This carries no hidden nutrition
or hunger counters. The core uses these facts in preference to narration for
`consumedItem`/`interrupted` outcomes. Other occupations still use the existing
bounded adapter and are not claimed to have equivalent structured coverage.

`game_ended {kind, cause, turn, health}` — an irrevocable engine outcome,
issued from `really_done()` **after** life saving/wizard refusal and before
post-game disclosure. `kind` is `death`, `quit`, `escaped`, `ascended`, or
`engineError`; `cause` uses NetHack's own formatted killer/result. This is
not inferred from a message or a closed pipe. The semantic core latches the
result and final gameplay perception, then closes the completed engine without
answering optional disclosure questions. Historical input replay may still
consume previously recorded post-game answers, without changing that result.
Older pinned engines may lack this notification; their generic exit is unknown,
not proof of death or victory. `session_ended {reason}` is a transport/window
closure notification and is not equivalent to `game_ended`.

`menu_start {window, behavior}` / `menu_item {window, index, accel,
groupacc, attr, color, text, itemflags, glyph?, selectable?}` / `menu_end {window,
prompt}` — items precede the pick request; picks are **ordinal indices**,
never pointers (the port keeps the `ANY_P`s). New pins report `selectable` from
the engine identifier, independently of accelerator assignment. Object-list
builders additionally emit `menu_object {window,index,objectId}` immediately
after the corresponding offered row. That ID is the same private identity as
in perception, not a pointer or a hidden item property. The adapter binds a
chosen floor object by identity, never by label or row order. Older pins without
these additive fields retain only supported legacy choices; missing object
bindings are an explicit limitation, not an inferred match.

`snapshot {full:true,cells}` / `map_delta {full:false,cells}` publish the
window port's shadow map. Cells carry x/y, glyph, ttychar, framecolor, cmap,
backgroundCmap, tileidx and color256idx. They are perceived display data, not
permission to query unseen level state. Window clears and level changes reset
the semantic map; full public checkpoints remain the review authority.

## 4. Engine input requests

The engine emits `input` with a numeric id and a `params.kind`. The raw reply
uses that exact id and a `result` object. Current port shapes are:

| kind | Result |
|---|---|
| key / poskey | `key` integer; poskey may also carry x/y/mod |
| yn | `answer`, one character |
| getlin | `line`, a bounded string |
| extcmd | `index`, an offered command index (`-1` cancels) |
| menu | `picks` integer indices, optional corresponding `counts`; or cancellation |
| ack | empty object |
| msgmenu | empty object or one-character `answer` |

These are engine internals, not public explorer controls. The public C adapter
supplies named actions, item identities and typed decisions. In particular,
malformed/missing raw answers can trigger port defaults; the adapter validates
stored shapes against the actual pending kind before replaying them.

## 5. Persistence requests

`persist_put`, `persist_get`, and `persist_list` are served by the adapter's
isolated per-run blob store. These deterministic persistence replies are not
new game intents and are not appended as input answers. Recorded histories are
not executable uploads; untrusted historical conversion requires the separate
OS sandbox documented in `docs/RECONSTRUCTION.md`.

## 6. Resume is a supervisor operation

Interactive resume validates complete LF-terminated UTF-8 input records,
initialization order, explicit seed, response shapes, and semantic metadata
before starting the pinned engine. It checks every stored answer against the
engine's actual input id/kind, rejects shell/suspend/debug replay commands,
and requires full consumption within a bounded deadline. A mismatch aborts
our child without offering EOF as a default answer. A partial replay is never
published as completed.

New private checkpoints include the committed input-byte boundary and a
completion flag; pending contexts also have a consistency fingerprint. Lost or
changed semantic boundaries require explicit recovery instead of a guessed
answer. See `docs/RECORDING_RECOVERY.md`. The raw engine alone does not provide
these supervisor guarantees.

## 7. Closure is not a game outcome

The raw port emits `session_ended` on EOF or protocol mismatch. Individual
window-port functions may otherwise return defaults when a result is missing.
Neither a closed pipe nor such a default proves death or victory. Use the
engine-issued `game_ended` facts, and keep failures/uncertainty distinct.

The native session supervisor has bounded shutdown and can abort an owned child
before closing its input. Passive archive review uses none of this protocol:
it reads public checkpoints without launching or commanding an engine.