# Runtime profiles and replay limits

Executable/data pins and WASM package pins prevent silent code/data upgrades.
Runtime **profile 1** additionally records the game calendar and isolates the
supported options/configuration inputs. Discovery advertises
`capabilities.runtimeProfile: 1`; absence on an older library is not a guarantee.

## Website input archives

New browser runs use [one append-only protocol input archive](CLOUD_SAVES.md)
for local durability, CDN backup and local WASM playback. Creation identity and
calendar are recorded explicitly. Response hashes and RNG boundary evidence
verify reconstruction; optional exact-package engine checkpoints accelerate it.
These unlisted archives include verifier evidence and checkpoint internals for
local reconstruction. They are readable by anyone with the replay URL, while
gameplay observations and receipts continue to expose perceived information only.
The public-trace utility below remains a separate opt-in diagnostic export.
It is not the website's storage path.

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

## Optional public traces

`neonethack/public-trace` exports `PublicTrace`, an opt-in recorder for public
requests and replies. It is disabled unless a caller constructs it and wraps a
transport. It stores gzip JSONL chunks in bounded memory and returns a manifest
plus byte arrays for an explicit export. There is no upload or automatic save.

```ts
import { Neonethack } from 'neonethack';
import { WasmTransport } from 'neonethack/wasm';
import { PublicTrace } from 'neonethack/public-trace';

const transport = await WasmTransport.create({ storage: { kind: 'memory' } });
const description = await new Neonethack(transport).describe();
const trace = new PublicTrace({
  runId: 'public-run-label',       // Same logical run across process restarts.
  processId: crypto.randomUUID(), // New player process, not necessarily a new life.
  codeVersion: 'YOUR_CLIENT_REVISION',
  runtime: { backend: 'wasm', packageId: transport.buildId,
    libraryVersion: description.libraryVersion,
    runtimeProfile: description.capabilities.runtimeProfile },
}, { maxChunkBytes: 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024,
  maxRecords: 10000 });
const api = new Neonethack(trace.wrap(transport));
// Explicit play through api; wait for each invocation to settle.
const exported = trace.export(); // Review before writing/sharing chunks + manifest.
```

The package ID must identify the runtime actually used. `libraryVersion` alone
is not that identity. WASM exposes its verified complete-package `buildId`.
Installed native clients should use the matching release manifest identity;
local tests label digests of their measured native binaries and static data explicitly. Do not fill
this field with the newest source revision or upgrade a package for recording.

Each entry retains the copied immutable request, full public response/events
(or a null response with `transportUncertain`), session ID, sequence number,
revision, turn, intended method, actual outcome, ended/end, runtime identity and
client code version. Sequence counts invocations, including queries and receipt
recovery; it is not elapsed turns or an assertion that engine input executed.
Run labels, actual session IDs and player-process IDs have separate meanings.
An interrupted recorder cannot fabricate missing results. Exports are explicitly
partial public evidence, never a complete history or an engine replay journal.

Each chunk contains one complete pair; a frame larger than the raw/compressed
chunk limit stops recording rather than truncating a response. The total
compressed byte and record limits bound storage; `trace.status.stopped` and the
manifest report a limit or recording failure. Gameplay responses still settle
normally if tracing fails. A trace failure never retries input or converts a
successful engine reply into transport uncertainty. Export is refused while an
invocation is outstanding.

Exports redact URL/path/credential fields, URLs and recognizable bearer/API-token
strings, and report redaction count plus whether public pairs were unchanged.
They are always marked non-replayable, including unredacted exports. The original
immutable in-memory request stays separate for exact receipt recovery; never use
a redacted export as retry input. Pattern redaction cannot recognize arbitrary
secrets in player-entered text: do not put credentials in game text, and review
before sharing. Public character names and perceived game text are retained.
Vault keys/URLs, private journals, saves and browser profiles are never trace
inputs. Keep retrospective traces out of a live player's information channel.

## Private RNG verification work

The current engine instruments ISAAC64's core and display streams with decimal
64-bit output-word counters, seed-operation counters, and SHA-256 fingerprints.
The fingerprint encodes the stream index, result-buffer position, complete
result/state arrays, and accumulator words as fixed little-endian 64-bit values.
It does not hash C struct padding, pointers, or native `unsigned long` storage.
Counters measure consumed output words, not the number of internal generator
mixing rounds. Counters remain cumulative across reseeding.

The low-level runtime carries this metadata in internal engine input-boundary,
final-result and lore-reply transport and the session's `rng.jsonl`. It is not a
semantic operation, gameplay observation, public receipt or MCP field. The website
input archive above deliberately includes it for local replay verification; do
not feed archive internals into an agent's live perceived scene. The same pinned runtime and calendar
remain necessary; this does not promise native/WASM state equality.

New sessions mark RNG verification version 1 in private metadata and in the
creation journal; resume rejects disagreement between them. Before answering
an engine input, the driver durably appends its input-history position, input ID,
prompt kind and RNG evidence. Final results record a terminal boundary. Resume
compares these records in order without rewriting them; missing, torn, changed or
extra evidence fails with `replayIntegrityError`. Supported older runs without the
marker do not acquire invented historical evidence.

**Validation status:** native private replay scenarios compare every captured
boundary. Native and browser WASM damaged-record scenarios verify fail-closed
resumption, including evidence persisted through IndexedDB reload and exact
receipt recovery without fingerprint disclosure in gameplay responses.
Repeated lore queries preserve both counters and state fingerprints. The driver
compares each lore reply with the last private input boundary and retires the
runtime on a mismatch. Native fault scenarios cover lost replies, wrong IDs,
malformed JSON, malformed result fields and changed RNG evidence; verified resume
preserves the original journal and standing decision. Free public
queries append no boundary records. Native/WASM SHA-256 comparisons cover padding
and streaming boundaries. A native query-volume scenario compares the next exact
RNG boundary after 400 observation, action-offer and navigation queries with an
unqueried control. Stronger receipt binding remains pending. Equal RNG evidence is not proof that
all non-random hidden engine state is equal.

To measure local costs, build the native engine and run:

```sh
node lib/neonethack/scripts/measure-rng-overhead.mjs
```

This creates a disposable instrumented engine and fresh run, calls the actual
fingerprint function 2,000 times while checking that its evidence stays unchanged,
and reports local durability and whole-search timings separately. It never prints
RNG state or reads an existing run. On Linux x64 / Ryzen Threadripper PRO 7975WX
(2026-09-07), fingerprint generation averaged 0.099 ms; the 100-sample local
file-and-directory sync probe had a 0.893 ms median and 1.482 ms p95. A full
one-turn search had a 15.541 ms median over 30 samples. The durability probe
includes Node asynchronous overhead, and full search includes all driver/engine
work. These are not incremental total-latency, WASM, or remote-storage measurements;
rerun on the target host rather than treating them as performance guarantees.
