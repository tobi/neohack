# Changes from NetHack

Base: NetHack commit `04834a93165482a28257bac282543e3583658622`.
This is a modified engine, **not** the unmodified upstream release.
Original copyright, no-warranty and `dat/license` notices remain intact.
These notes identify changes; they do not grant a new license for independently
owned project code. The repository's publication/license review remains open.

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
