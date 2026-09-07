# Changes from NetHack

Base: NetHack commit `04834a93165482a28257bac282543e3583658622`.
This is a modified engine, **not** the unmodified upstream release.
Original copyright, no-warranty and `dat/license` notices remain intact.
These notes identify changes; they do not grant a new license for independently
owned project code. The repository's publication/license review remains open.

## 2026-09-07 — private RNG integrity instrumentation

- src/rnd.c: count core/display ISAAC64 output words and seed operations,
  with overflow checks; fingerprint canonical state with SHA-256. Counters
  do not call either RNG and do not change its output. The encoding excludes
  pointers, padding, host endianness and unsigned-long width.
- include/nh_sha256.h: allocation-free byte-oriented SHA-256 used only for
  private integrity fingerprints, tested against host crypto at native/WASM
  padding and streaming boundaries.
- win/headless/rpc.c and winheadless.c: attach private integrity metadata to
  engine input boundaries and the out-of-band lore reply. The semantic driver
  does not forward this metadata into public gameplay frames or receipts.
  Durable boundary storage/comparison is a separate driver integration step.

## 2026-09-07 — native counted search and rest

- win/headless/winheadless.c: an explicit bounded count supplies only the
  digits and one search/rest command to NetHack's existing count parser.
  Timed occupations, refusals, interruptions and elapsed game time stay in
  the engine. No repeated-command loop or automatic warning answer is added.
- src/detect.c and src/do.c: witness actual search/rest executions so a counted
  occupation's completion or interruption is reported without inferring it
  from intended input or elapsed time. A refused search emits no searched fact.

## 2026-09-07 — pinned encyclopedia query

- src/pager.c: reuse the actual encyclopedia matcher with a text sink that
  bypasses UI windows, messages and input. Exposes only typed-name lookup;
  no observed or hidden creature identity is supplied to the matcher.
- src/objnam.c: preserve the rotating object-name buffer pool across a free
  lore query, including its allocation index, so suspended prompts retain
  their strings. include/extern.h declares these headless-only hooks.
- win/headless/rpc.c and winheadless.c: handle an out-of-band lore query while
  retaining the existing input ID and suspended callback. These queries do
  not enter the deterministic gameplay input journal or advance game time.

## 2026-09-07 — equipment intent and displayed passages

- Headless perception supplies physical wearable destinations without revealing
  magical identity or curse status. do_wear marks the real ring-hand choice so
  an explicitly requested hand can be bound without parsing the prompt.
- Text windows retain their lines and emit a displayed passage. questpgr marks
  its menu-style narrative windows explicitly; no story classification by text.
  Existing messages, engine warnings, timing and game rules remain in effect.

## 2026-09-06 — standalone native packaging

- `src/mail.c`: handle a missing OS account entry when discovering a local
  mailbox. Minimal containers can omit `/etc/passwd`; starting a game must not
  dereference a null `getpwuid()` result. Existing mailbox behavior is unchanged
  when an account or explicit mailbox is available.

## 2026-09-03 through 2026-09-05 — neonethack project

- `win/headless/*`: added the private NDJSON window port, bounded JSON/RPC
  transport, startup helpers and diagnostic driver. Exposes input boundaries,
  perceived map/inventory/status, action/lifecycle events and persistence hooks
  to the semantic C driver. It is not the public client protocol.
  On 2026-09-05, `winheadless.c` also supplies visible background terrain beneath
  objects/creatures without inspecting unseen terrain, and maps Escape through
  the restricted prompt's quit/no/default cancellation contract rather than
  returning an invalid raw Escape. The semantic driver retains door orientation
  from disclosed map symbols; it does not query private door state.
- `include/extern.h`, `include/winprocs.h`, `src/windows.c`: headless declarations
  and window-port registration.
- `src/allmain.c`, `src/eat.c`, `src/spell.c`: action/occupation boundary and
  interruption reporting, without automatically continuing an activity.
  Meal interruption is reported at the actual `stop_occupation` boundary, not
  delayed until a later reset. A presentation-only flag avoids duplicate
  interruption events from that deferred reset; game state/rules are unchanged.
- `src/end.c`: terminal and lifesaving events, distinguished from one another.
- `src/pickup.c`: identity metadata for currently offered object menu entries.
- `src/lock.c` (2026-09-05): report witnessed door lock state after successful
  locking/unlocking or explicit trap-disarming feedback. No hidden lock-state
  query is exposed; the headless event follows actual player-visible evidence.
- `src/mdlib.c`, `sys/unix/unixmain.c`: deterministic seeded headless startup and
  private port startup arguments. Entropy fallback remains when no seed is set.
- `sys/unix/Makefile.src`, `sys/unix/hints/include/multiw-2.500`: headless objects
  and window-port selection.
- `sys/unix/hints/headless.500`: derived Linux build configuration, Lua supplied
  by the caller/build recipe, relative per-session data/config paths, source
  prefix mapping and operation without Git metadata.

- Runtime profile 1 (2026-09-05): `win/headless/cli.c`, `cli.h` and
  `winheadless.c` accept a recorded creation epoch before initialization and
  acknowledge the profile/epoch during handshake. `src/calendar.c` uses that
  fixed epoch and UTC conversion; `src/u_init.c` uses it for birthday;
  `src/allmain.c` uses the same clock for reroll accounting. `src/options.c`
  bypasses user RC/options for profiled worlds and uses the fixed headless
  defaults. Unprofiled private-engine mode keeps its prior behavior; the public
  semantic library refuses to invent settings when resuming unprofiled history.

On 2026-09-05 the port's seed prototype was centralized, a shadowing local was
renamed and an unused status callback removed. These are compile hygiene changes,
not new game rules. `SOURCES.json` is the source-package inventory; generated
headers, binaries, playgrounds, saves and optional submodule checkouts are absent.

- Container interaction: the headless object perception now reports recognizable
  container shape (including every bag type) without disclosing contents, locks,
  traps, or curses. Hallucination suppresses this affordance. The shared semantic
  driver uses it to offer NetHack's existing loot command underfoot.
- On 2026-09-06, `pickup.c` replaces the headless container mode/category menus
  with explicit unknown-content inspection and a combined take/put object menu.
  `winheadless.c` emits structured container phase and transfer-side metadata.
  Original `in_container`/`out_container` retain warnings, effects, capacity,
  billing and interruption. Selected object IDs and initial quantities are
  snapshotted before take-first execution, preventing merged inventory stacks
  from enlarging an approved put. Native and WASM use this same implementation.
- `win/headless/pickup-settings.inc` adds structured ground-pickup configuration
  before game creation and via zero-turn command-boundary responses. It sets
  explicit object classes (venom sentinel for none), installs POSIX exception
  patterns with exclusion precedence, and neutralizes thrown/stolen/dropped
  early overrides so the advertised filters apply consistently. Active settings
  are emitted with perception and recovered by the existing input journal.
  Original shop, burden, warning and manual pickup rules are retained.

- On 2026-09-06, the NEO-19 semantic review changes `win/headless/winheadless.c`
  to initialize and clear map cells with `NO_GLYPH` and absent background
  sentinels. Glyph zero remains a valid displayed creature. Display clearing
  also clears apparent species, preventing stale labels after hallucination or
  disappearance. Shared C projection now uses these perceived display facts
  consistently; monster behavior, hidden knowledge and action costs are unchanged.

## 2026-09-06 — literal pickup patterns

- `win/headless/pickup-settings.inc`, `src/pickup.c`, `include/extern.h`: bounded loot/ignore substring rules against perceived singular item names; ignore and existing leave rules override inclusion. No hidden identity matching or automatic container interaction.

- Mark the optional type-naming prompt reached after an inconclusive potion drink
  with explicit headless text context. The shared driver exposes this as an
  optional text-decision purpose; potion effects, identification, consumption and
  cancellation remain the original engine operations.

- `src/pickup.c`, `win/headless/winheadless.c`, `win/headless/pickup-settings.inc`,
  and `include/extern.h`: optional explicit automatic-pickup review uses a real
  pre-transfer choice with filter suggestions. Successful transfers report exact
  acquired quantity and post-merge stack identity; inspected containers report
  their disclosed contents. Existing warnings, traps, burden and shop rules remain.

- On 2026-09-06, headless item knowledge includes the known physical appearance
  separately from identified properties, using shuffled object descriptions and
  suppressing it while hallucinating. No engine inputs or random draws are added.

- On 2026-09-06, carried-item perception exposes actual equipment slot assignments
  from hero equipment pointers and punishment masks. It distinguishes armor
  layers, ring sides, alternate/offhand use and merged skin; it excludes artifact
  property masks and introduces no input, randomness or item eligibility rules.
