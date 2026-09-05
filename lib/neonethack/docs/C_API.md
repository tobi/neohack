# C API

Install and include only `neonethack.h`. It includes standard size/integer types,
is valid in C and C++, and exposes no NetHack or process-control headers.

```c
#include <neonethack.h>
#include <stdio.h>

int play(const char *engine, const char *data, const char *sessions) {
    nnh_config config = { sizeof config, engine, data, sessions };
    nnh_context *context = NULL;
    nnh_result *result = NULL;
    nnh_identity hero = {0};
    hero.name = "Ada";
    if (nnh_context_open(&config, &context) != NNH_OK) return 1;
    if (nnh_session_create(context, &hero, &result) == NNH_OK) {
        puts(nnh_result_json(result));
        /* Copy session ID/revision before freeing the result. */
        nnh_result_free(result);
    }
    nnh_context_close(context);
    return 0;
}
```

Link with `libneonethack.a` and pthreads (or build with `BUILD_SHARED_LIBS=ON`).
CMake consumers can use `find_package(neonethack CONFIG REQUIRED)` and link
`neonethack::neonethack`; pkg-config consumers use `neonethack` (with `--static`
when linking the archive). See [`examples/c/main.c`](../../../examples/c/main.c)
for a complete public-header-only client. The native
engine remains a separate, isolated process per game; embedding NetHack's global
state or `exit()` in the host application is not safe.

The shared library dynamically exports only the functions declared in
`neonethack.h`. Parser, private driver and process helpers are hidden; a host
symbol of the same private name cannot interpose on them. Linux installation
tests compare exported symbols with the header and exercise a conflicting host
parser symbol. Static archive definitions use only public names and the
reserved `nnh_private_*` namespace: generic names such as `mj_valid`, `nhx_open`
and `nh_session_start` do not collide with the host. Private names are not a
second API; applications must not define/call them. Both GCC and the installed
SDK's Clang passed the Linux static/shared install/consumer matrix. This is not
a claim of Windows/macOS portability or cross-host game equivalence, and it
does not change the serialization requirement.

## Ownership

- Config, identity, guard, item, target, answer and JSON inputs are borrowed only
  during the call. The library does not retain caller pointers.
- A successful delivery sets an owned `nnh_result *`. Free it with
  `nnh_result_free`, never a different allocator.
- Result accessors return borrowed immutable pointers valid until result-free.
  Results can outlive the context. Session IDs must be copied if retained.
- Context-close retires all engines and releases resources, not stored history.
- Close/free tolerate NULL. `out` arguments do not: an invalid output pointer
  returns `NNH_INVALID_ARGUMENT`. Failed calls leave `*out == NULL`.

## Two kinds of error

`nnh_status` reports whether a library call delivered a result:
`NNH_OK`, `NNH_INVALID_ARGUMENT`, `NNH_OUT_OF_MEMORY`, `NNH_SYSTEM_ERROR`.

`NNH_OK` does **not** mean the game action succeeded. Check
`nnh_result_error(result)` and inspect the JSON outcome. A blocked kick, a
cancellation, a real warning and an interrupted meal are game results, not
allocation or transport errors. Error-only protocol results have no revision;
`nnh_result_revision` then returns -1.

The immutable result JSON follows the same protocol as TypeScript and MCP.
The accessors provide common routing fields; use your preferred JSON parser for
observations and decisions rather than relying on engine structs or ABI-layout
copies of variable-sized world data.

## Typed operations

Each operation has a named function: `nnh_game_move`, `nnh_game_eat`,
`nnh_game_pray`, etc. Mutations take `nnh_guard {request_id,expected_revision}`.
Keep the same guard **and all arguments** when retrieving a timed-out receipt.

- `nnh_direction` distinguishes eight compass directions and up/down.
- `nnh_target` distinguishes self and direction; individual methods constrain it.
- `nnh_item` has exactly one non-NULL `id` or `name`. A NULL item pointer asks for
  candidates. Invalid/ambiguous selectors are not guessed.
- `nnh_answer` is a tagged union for item, target, confirmation, choice and text.
  Confirmation is exactly 0 or 1. Choices are returned integer IDs, not slots.
- `nnh_decision_cancel` is separate from answering. Pass the standing decision ID.

The typed API serializes into the same strict C protocol validator. Passing a
bad enum, irrelevant target or missing guard cannot bypass schema checks.
`nnh_dispatch` is the length-delimited bridge for bindings that already use JSON;
it does not expose legacy raw input or reconstruction methods.

## Concurrency and paths

Currently **serialize all calls within a process**, including calls on different
contexts. The core is not yet a thread-safe API; ID allocation and other shared
state have not been made concurrency-safe. Use independent bridge processes for concurrency. Do not treat separate handles
as a thread-safety guarantee. A context can own several isolated game sessions.

Pipe writes suppress only the calling thread's new SIGPIPE signal and return an
error if the engine disappeared. The library does not install a process-wide
signal handler or require the host to ignore SIGPIPE. Arguments and environment
are prepared in the parent without changing the host environment; the library's
post-fork child branch uses only async-signal-safe operations before `execve`.
Hosts must not concurrently mutate `environ` while the library snapshots it;
host-installed at-fork callbacks remain the host's responsibility. Closed standard
descriptors are supported. Linux has direct post-fork/closed-stdio regressions.

Profiled native children receive a minimal environment, not host option strings,
user homes or loader hooks. The engine bypasses user RC files and uses the
recorded fixed UTC calendar. Unprofiled histories are refused without inventing
missing settings. See [runtime profiles and remaining replay limits](REPLAY.md).

New worlds receive only allowlisted static data and fresh runtime files, never
another playground's saves, bones or logs. Each session pins its static data as
well as its executable; later builds do not replace those pins. Installing into
a versioned prefix is recommended rather than upgrading an actively used prefix.

Paths select trusted local executables/data/storage. They are not untrusted game
parameters. Sessions must not be supplied as arbitrary uploaded executables or
input journals. Native leases and conservative integrity checks are not a
multi-user authorization system.

ABI version 1 uses fixed public enums and opaque handles. `config.size` must be
`sizeof(nnh_config)`; a mismatched layout fails instead of being interpreted as
another ABI. Protocol version and library version are separate.
