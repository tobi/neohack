# Local runs, input archives and online backup

The website runs NetHack locally in a browser worker. Once its pinned package is
available, network access is optional for starting, playing and resuming a local
run. The installed PWA caches the shell, artwork and current runtime; supported
older runtime caches survive an application update.

Bookmark the full play URL:

```text
https://neohack.dev/#run=SESSION_ID&vault=UPLOAD_CAPABILITY
```

The fragment never accompanies the page request. Keep this bookmark private:
the vault capability can upload and find runs. Sharing a replay instead gives a
static manifest URL with only the unguessable run ID. Anyone with that replay
link can read the recorded game. Script source, script notes and account identity
remain separate, authenticated data.

## One authoritative input log

New website and workshop runs use the WASM `journal` storage mode and the
`neonethack.inputs` version 1 format. They record creation settings, the chosen
seed, creation UTC epoch, opaque run ID, exact runtime build ID, and ordered
client-to-engine protocol requests. This includes decision answers, cancellation,
settings updates and rejected attempts. Read-only queries are not recorded.

Each input is added to IndexedDB in a strict transaction **before** C receives
it. A second transaction adds completion evidence and advances a small run
header. Neither write reads or rewrites the previous inputs. Completion evidence
contains a response SHA-256 and internal core/display RNG boundary fingerprints;
it does not contain a full observation. These verifier records are outside the
gameplay observation and receipt surfaces. They are included in the unlisted
archive for replay verification, along with optional engine checkpoints.

A seed alone is not sufficient. The exact engine, data, calendar, options and
input sequence must agree. [REPLAY.md](REPLAY.md) explains the limits. The C
semantic driver continues to own actual execution and exact request receipts.
A missing completion is an uncertain reserved input, not permission to issue a
fresh action in the old process. Restoration reconstructs a fresh process from
the verified prefix, completes its single reserved tail once, then retains the
original request ID and receipt. Missing committed rows, gaps and changed
fingerprints stop restoration; they are not truncated or silently repaired.

## Bounded asynchronous upload

After five seconds idle, or thirty seconds of ongoing activity, the worker reads
only the next unacknowledged range. Batches contain at most 128 input records,
at most 1 MiB decoded and 512 KiB compressed. Large counted actions cause an
earlier batch boundary. The compressed bytes and SHA-256 are retained locally
before upload. An acknowledgement must identify exactly that hash and end cursor;
a lost acknowledgement retries identical bytes without re-executing the game.

Before the first upload in a worker, the website registers that run in the vault
directory through a cancellable background prerequisite. The same directory
writer coalesces current per-run metadata; ledger publication is independent.
Registration failure retains the pending compressed bytes and cursor, and retries
registration rather than a game input. Reload re-establishes the prerequisite from
local run metadata. Closing the transport cancels it without waiting for network.

Directory and ledger updates retain established WebMCP attribution when a later
manual snapshot arrives, including delayed same-turn writes from a former tab.
Other control labels retain their existing replacement behavior. This attribution
rule does not order other same-turn metadata or change journal ownership.

`PUT /api/runs/:id/inputs` validates the write capability, sequence, runtime and
size limits. It publishes an immutable `chunks/<sha256>.gz` object and conditionally
advances the run head and a hash-named immutable manifest. The mutable
`manifest.json` is only a discovery alias; acknowledgements and embed links pin
the exact immutable playlist, so CDN invalidation cannot hide acknowledged data.
Previous chunks are never downloaded
or concatenated on normal upload. Errors leave the local log and exact pending
batch intact. Reconnect retries quietly. Upload latency is outside the action
promise; closing a tab can leave a prefix pending until the browser returns.
An account can associate the run for later discovery, but is not needed to play.

These are separate immutable batch files, with no mutable growing tail. At scale,
storage consists mainly of compressed requests rather than repeated maps; a
batch requires one chunk publication and small head/manifest updates. Accounts
and ledger indexing have additional costs. This format does not claim the existing
ledger index is already designed for millions of entries.

## Resume and level checkpoints

Local resume reads the input log using the recorded package. A fresh device first
resolves the latest immutable playlist through authenticated
`GET /api/runs/:id/inputs`, then imports static manifest/chunk files from the CDN, retaining its import cursor if
download is interrupted. The current network worker may service an older pin;
the semantic C driver, engine, static data and checkpoint identity still come
from that recorded package. A different engine pin is refused. Existing published
pins and recorded histories are not replaced on deployment.

After a level transition, a quiescent WASM checkpoint can accelerate subsequent
resume and seeking. It includes the actual engine and C-driver linear memory,
Asyncify continuation, virtual files, open file positions, host queues and package
identity. A full response is included only as its display preview. A response
alone cannot restore hidden state, RNG, inventory identity or pending decisions.
Compression runs in a separate worker; the boundary memory copy still has a
finite cost. Checkpoints are optional caches, limited to 4 MiB compressed and
captured on first entry to a level, then at most once per 256 inputs for repeat
visits to that level. Decoded checkpoints are limited to
256 MiB. Invalid caches fall back to full verified input replay; bad
inputs do not. Checkpoint ABI is tied to the exact runtime package.

## Watching

The viewer reads the static manifest and hash-named chunks directly from Blob/CDN,
then executes the recorded inputs in an isolated local WASM runtime. It can show
the first scene before later chunks arrive, and seek from a preceding checkpoint.
Watching performs no account lookup, upload, ledger request or dynamic replay
assembly. A foreign-origin embed uses the same static files under ordinary CORS
and its host page's worker/CSP policy. Old published observation archives remain
readable by their existing viewer; new runs do not write that format.

## Verification

`tests/wasm/protocol-recording.test.mjs` exercises real WASM/IndexedDB loss,
pending decisions, cold exact receipts, missing rows, runtime pins, RNG equality
and a real level-transition checkpoint. `protocol-format.test.mjs` tests binary
bounds, playlist integrity, debounce, lost acknowledgements and chunk limits.
The Vercel protocol tests exercise publication failure, static progressive and
cross-origin playback, fresh-device restore and installed PWA offline reload.

The separate `indexeddb` block-replication mode remains supported for already
published website saves and explicit library consumers; see [WASM.md](WASM.md).
It is not used for new website/workshop recordings. Clearing browser storage can
still delete unsynced inputs, and storage quota failures remain real durability
errors rather than offline notices.
