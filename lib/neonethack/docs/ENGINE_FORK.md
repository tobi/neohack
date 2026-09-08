# Engine fork audit

The base is [NetHack `04834a9`](https://github.com/NetHack/NetHack/tree/04834a93165482a28257bac282543e3583658622).
The 2026-09-08 shipping-source comparison found **1,236 unchanged upstream
files, 30 modified upstream files, and 14 added files**. These counts describe
the engine source inventory, not generated headers, installed data or binaries.
Run the audit again after engine work; the count is a dated measurement.

## Repeat the comparison

```sh
curl -fL https://codeload.github.com/NetHack/NetHack/tar.gz/04834a93165482a28257bac282543e3583658622 -o /tmp/neohack-upstream.tar.gz
mkdir -p /tmp/neohack-upstream
tar -xzf /tmp/neohack-upstream.tar.gz --strip-components=1 -C /tmp/neohack-upstream
node lib/neonethack/scripts/audit-engine-fork.mjs --upstream /tmp/neohack-upstream --out /tmp/neohack-fork.json
```

Use an empty extraction directory. The tool verifies the entire unpacked
upstream tree against its pinned content fingerprint before comparing files.
It rejects unexpected upstream edits and unclassified modified upstream paths.
It emits per-file hashes, classifications and a shipping-source fingerprint.
It performs no network access itself and never changes engine sources or saves.
It inventories changes; classification is not a substitute for reviewing new
hunks in a previously classified file.

The downloaded archive used for this audit had SHA-256
`48d957f626b8d525bc3c0224e5cec1e711e837ae8a7dccfff081c63013cdf1b9`.
The tool checks unpacked contents rather than relying on archive compression
or timestamps. See [dated patch notes](../engine/CHANGES.neonethack.md).

## What is already outside the engine rules

- **Background terrain:** `win/headless/winheadless.c` uses the existing
  `back_to_glyph` renderer for visible terrain beneath displayed occupants and
  underfoot. This adds no patch to `display.c`. Visibility, swallowing and
  furniture disguises still limit what is disclosed. Reading the raw map would
  violate these restrictions.
- **Walked squares:** `src/explorer.c` records actual witnessed standing positions
  from the port's perception snapshots, indexed by public level identity. It
  does not patch movement or infer visits from arbitrary hero-glyph redraws.
  Frontiers exclude these cells. This witnesses input boundaries; it does not
  claim every animation coordinate or hidden intermediate position was visited.
- **Routes and movement policy:** `src/affordance.c` resolves perceived movement
  and known walking routes. Clients do not duplicate terrain tables. Navigation
  policy remains separate from physical eligibility and the actual movement
  operation.

## Retained upstream modifications

Paths below are relative to `engine/`. Every modified upstream path in the
comparison is covered. Several files have more than one reason to remain.

| Files | Purpose and reason to retain |
| --- | --- |
| `include/extern.h`, `include/winprocs.h`, `src/mdlib.c`, `src/windows.c` | Register the port and declare narrow callbacks. Required integration glue; `mdlib.c` adds window-port metadata, not an RNG implementation. |
| `sys/unix/Makefile.src`, `sys/unix/hints/include/multiw-2.500` | Compile/select the port. These are build integration, not gameplay rules. |
| `sys/unix/unixmain.c` | Consume private startup arguments before upstream option parsing; seed override before RNG initialization. Seed wrapping is a candidate, but full target equivalence has not been demonstrated. |
| `src/calendar.c`, `src/u_init.c` | Recorded epoch, UTC conversion/inverse conversion and birthday. Wrapping `time` alone does not supply this complete contract. |
| `src/options.c` | Prevent host RC/options from changing a pinned session. A time/seed wrapper would not isolate configuration. |
| `src/allmain.c`, `src/eat.c`, `src/engrave.c`, `src/spell.c` | Report actual occupation completion/interruption, including deferred meal reset, without restarting it. `allmain.c` also uses the recorded clock for reroll accounting; `eat.c` binds offered floor objects; `spell.c` exposes existing spell-menu facts and uses explicit spell choices. Window output alone cannot distinguish all these boundaries. |
| `src/detect.c`, `src/do.c` | Witness actual counted search/rest executions, including refusal. Intended input and elapsed time cannot prove which command executed. |
| `src/do_wear.c`, `src/invent.c` | Explicit ring-hand context and object-bound getobj selection/counts. Preserve opaque identity and the real engine's item handling rather than parsing prompt labels or inventory letters. |
| `src/potion.c`, `src/questpgr.c` | Mark the genuine optional potion nickname prompt and narrative passages. Text heuristics cannot reliably identify purpose. |
| `src/end.c` | Separate lifesaving from actual death, capture terminal cause before disclosure and score after final accounting. Suppress the postmortem disclosure quiz. Do not infer terminal facts from a message or automatically answer a live warning. |
| `src/insight.c`, `src/weapon.c` | Reuse existing chronicle/skill naming and disclosure logic, including spoiler exclusions and skill eligibility. Helpers need private engine tables/functions; copying those tables to the port would increase semantic duplication. |
| `src/lock.c` | Emit lock-state witnesses next to the actual player-visible disclosure. A free raw-door query would reveal hidden state. |
| `src/botl.c` | Compute headless self-state conditions independently of optional visual status toggles, using the existing engine predicates. This avoids copying held/grab/holding and other condition rules into the window port or clients. |
| `src/pickup.c` | Bind offered object IDs, combined container transfers, witnessed loot and explicit pickup review. Retain original transfer, burden, billing and trap functions. This is an intentional interaction change and should not be described as a passive display hook. |
| `src/pager.c`, `src/objnam.c` | Reuse the real encyclopedia matcher with a separate text sink and restore name scratch buffers around free queries. Ordinary window capture could alter a suspended prompt or journal. |
| `src/rnd.c` | Count actual core/display RNG words and reseeds; fingerprint canonical ISAAC64 state for the private replay channel. Public observation equality cannot verify this state. |
| `src/mail.c` | Handle absent OS account records in the single-file native bundle's minimal container. A window-port change cannot prevent that dereference. |

The added files are the headless port, its knowledge/pickup helpers, the headless
Unix configuration and patch notes. No replacement terrain, combat or object
rule engine is added in JavaScript.

## Wrapper experiment and limits

Repeat the small probe (it requires both toolchains):

```sh
node lib/neonethack/scripts/probe-engine-wrappers.mjs --emcc /path/to/emsdk/upstream/emscripten/emcc
```

A small linked-symbol probe was run with native `cc -O0` and Emscripten `-O0`,
using `--wrap=sys_random_seed` and `--wrap=time`. The original seed function
returned 7; its wrapper returned 42; the time wrapper returned epoch zero.

| Target | External seed call | Call within defining source file | UTC local hour | Honolulu local hour |
| --- | ---: | ---: | ---: | ---: |
| Native linker | 42 | 7 | 0 | 14 |
| WASM linker | 42 | 42 | 0 | 14 |

This demonstrates a real linker difference and that frozen `time()` does not
freeze calendar interpretation. It does **not** prove wrappers cannot work.
The current seed caller in `rnd.c` is external to `unixmain.c`, making that hook
a plausible isolated candidate. A replacement still needs actual native,
static-musl and WASM runs covering startup, UTC/calendar conversions, different
host timezones and exact replay before removing the working hooks. Wrapping
all time-related functions also needs review for host diagnostics and startup
code that must retain real wall time.

The existing native/WASM replay tests validate the retained implementation.
The probe is not evidence of full game equivalence. No runtime-pin migration,
published-save rewrite or unverified wrapper replacement was made by this audit.

## Upstreaming direction

A reusable window-port callback for structured input choices and witnessed
outcomes would remove more integration friction than moving private tables
between files. Keep the headless transport independent of the semantic library;
propose callbacks for object-bound selections, occupation results and terminal
facts with their behavior tests. Treat container interaction changes and
reproducible-runtime configuration as separate proposals. No upstream acceptance
or unchanged-engine equivalence is claimed.
