# Runtime profiles and replay limits

Executable/data pins and WASM package pins prevent silent code/data upgrades.
Runtime **profile 1** additionally records the game calendar and isolates the
supported options/configuration inputs. Discovery advertises
`capabilities.runtimeProfile: 1`; absence on an older library is not a guarantee.

## Profile 1: fixed creation calendar in UTC

New worlds record `runtimeProfile: 1` and `calendarEpoch` in their private
initialization journal, before creating the hero. The semantic C core reads the
creation epoch from its wall clock (1970–2099), and passes it to the engine before
initialization. The engine must acknowledge the exact profile/epoch before
`new_game` is sent. Resume uses the recorded value, not the current clock.

The engine's game calendar stays at that instant, interpreted in **UTC** for the
whole world. Moon phase, Friday the 13th, night/midnight, birthday and calendar
formatting therefore do not change when the caller pauses, moves time zones or
resumes on a different day. This is a deliberate headless-runtime policy, not
real-time day/night simulation. Engine elapsed-real-time accounting is frozen
as well; game turns remain the measure of activity. Bridge timeouts, recording
timestamps and storage mtimes still use their actual clocks.

A seed alone is not a complete world identity. Different creation calendars can
produce different behavior; different native/WASM targets can produce different
maps. The profile does not promise bit-identical cross-target or cross-host
binaries, nor is final observation equality a proof of hidden-state equality.

## Isolated options/configuration

Profiled engines bypass user RC files and `NETHACKOPTIONS` processing, using the
fixed headless overrides `!tutorial,time,number_pad:0` over the pinned engine/data
defaults. A user's pet preference, renamed hero, key bindings, tutorial setting
or options-as-filename cannot silently change an operation or resumed world.

Native children receive a minimal environment: fixed user name `Explorer`, C
locale, UTC, default system tool path, session-local HOME/data paths and the
headless option defaults. Host loader hooks and other inherited environment
variables are not passed to a profiled engine. The parent environment and signal
handlers are not changed. Caller-supplied engine/data and native storage remain
**trusted resources**: this is not an OS security sandbox or authenticated history
format. Kernel/libc/toolchain differences are not covered by a universal replay
proof. WASM uses the same C profile and calendar code, not JS game rules.

## Historical worlds: no invented migration

A journal without a runtime profile is refused with `runtimeUnavailable` before
an engine is started or history is rewritten. Malformed, partial, unknown or
out-of-range runtime fields fail input validation. The library does not guess
an old calendar or options, add missing fields, replace pins or implicitly
upgrade a WASM package. Keep the original complete runtime and world files for
historical access; their original limitations still apply.

The bug motivating this policy was reproduced through the public native API:
changing `NETHACKOPTIONS` to remove pets allowed a successful old-style resume
without the original perceived ally. Matching input IDs and prompt shapes did
not detect the changed world. Silently applying today's defaults to those old
journals would not repair the missing information.

## Tested boundaries, not universal guarantees

- Native adversarial tests change wall clock, time zone, option strings,
  options-as-filename and user RC/key bindings. They verify the actual engine's
  Friday-the-13th output, pending consent, unchanged input bytes and subsequent
  play against an uninterrupted same-profile world.
- WASM tests use a Friday UTC that is Saturday in the host time zone, change the
  clock across engine restart, and compare subsequent play with an uninterrupted
  twin. New worlds demonstrate that the injected clock actually changed.
- Equipment/menu/armor-occupation traces retain genuine choices, cancellations,
  selected item identities, turn costs and receipts. Native real-play lifesaving
  and death retain their distinct meanings through cold bridge restart.
- Linux fault injection checks pre-input request/input/metadata fsync failures,
  post-input semantic-boundary failure without consent, and degraded checkpoints
  after actual execution. The interposer is test-only and never installed.
- A rejection before reservation may be explicitly retried after caller recovery.
  A reserved request without a receipt remains uncertain. Neither permits a
  transport/client to silently issue a new request and repeat work.
- Torn journals are refused without completing/truncating them. Tests do not
  establish general power-loss, storage-hardware or malicious-tampering safety.

Preserve original packages, pins and damaged history. Never recover a world by
inventing answers or automatically replaying it with upgraded code.
