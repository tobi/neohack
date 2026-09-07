# Browser runs and cloud journals

The live client gives an active run a stable URL:

```text
https://neohack.dev/#run=SESSION_ID&vault=PRIVATE_VAULT_KEY
```

Bookmark the whole URL. Opening it selects that vault, restores its journal when
needed, and calls the public `session.resume` operation. The same C semantic
core that serves native clients replays the recorded inputs and restores the
standing decision. The browser does not recreate game rules or invent answers.

The fragment is not sent with the page request. The vault key authorizes access
to that vault's saved adventures, so keep the URL private. It is not a public
spectator link. Separate vaults use separate local databases and Web Locks.
The deployment must serve the same origin for the page and its journal API.

## What is saved

No engine heap or rendered map is uploaded. Persistence contains the C driver's
input journal, runtime identity, semantic boundary metadata, request reservations
and receipts. Perception recordings retain exact historical responses needed for
request recovery; they are not engine-memory snapshots.

A seed alone is insufficient: the recorded creation calendar, options profile,
engine/data identity and target also matter. See [replay guarantees](REPLAY.md).
Receipts and pending-context metadata cannot be discarded merely because the
engine can regenerate its world. A reserved request with no receipt remains
uncertain, and replay must not treat it as a new action.

## Local durability and background replication

Every active website run attempts background backup automatically. A local
recovery bookmark may skip remote restoration, but never disables uploading.
Offline play resumes syncing when the connection returns, without a toggle.

C pre-input `fsync` boundaries still wait for strict IndexedDB transactions.
Remote latency is outside that boundary. After a completed protocol request, a
five-second inactivity debounce batches the latest committed journal data for upload,
with a thirty-second maximum delay during continuous play. One upload
runs at a time; new input can continue while it is in flight. Unchanged
content-addressed blocks are not resent. Vercel stores immutable blocks separately
in private Blob storage and conditionally commits the file manifest, exact request
digest and revision using its ETag. A stale writer cannot replace newer progress.
Upload requests are bounded to fit Vercel Functions' payload limit.

Each upload has a durable commit ID and base revision. Network retries send the
same immutable upload. The server accepts an identical retry, rejects a changed
retry or stale base, and checks that every referenced block is present. An
acknowledgement lost during page shutdown is reconciled from the durable outbox;
no game action is executed to recover a transport acknowledgement.

A browser whose local journal still matches its last acknowledged copy can
refresh from a newer cloud revision after validation. Unsynced or conflicting
local progress is retained instead of overwritten. The website gives each browser
copy a durable random backup-stream ID, stored alongside its local journal.
Streams use separate conditional Blob manifests under the same private vault.
A new stream starts with a full verified snapshot; later commits send only changed
blocks. A returning browser keeps its stream. A fresh browser restores the
acknowledged stream named in the adventure directory, then backs up independently.
Neither browser overwrites the other’s history. The former shared vault head and
any uncertain pre-stream outbox are retained. No engine journal is rewritten.
Hash, manifest or reference failures reject the journal before installing it.

**Saved online** means the cloud journal and adventure metadata were acknowledged.
**Saving online…** means local progress is durable but newer changes may not yet
be available on another device. Closing a runtime explicitly flushes pending
uploads; abruptly closing a tab can leave unsynced progress in that browser.
Each request has a ten-second timeout. Network failures, HTTP 408/429 and server
errors retry in the background with exponential backoff capped at one minute.
The durable outbox retains the exact commit ID, base and body across retries and
reloads; newer local work waits behind that acknowledgement. The UI says
“Saved here · retrying online”, without an error toast for temporary failures.
Within one stream, conflicting writers, refused access and invalid acknowledgement identities stop replication
and retain local progress for explicit recovery. Close makes a bounded flush
attempt; abrupt termination can still leave pending local work.

Network-worker updates are independent of the pinned C/WASM package. Existing
runs retain their exact engine and static-data identity. Adventure metadata and
ledger updates retry independently in batches of at most fifty, so a long history
or a temporary ledger outage cannot stop journal uploads. Only acknowledged
backup streams are advertised for remote resumption.

WASM resumption requires the same package identity. Incompatible development
packages are refused, not silently substituted or migrated.

## Performance reproduction

A fresh real WASM run followed by three search turns previously triggered 93
whole-store PUTs, totaling about 1.51 MB. With 100 ms of simulated server latency,
each search took about 2 seconds. The background batching implementation reduced
this trace to one approximately 24 KB upload; searches took 20–24 ms with the
same latency. These are local Chromium measurements, not production latency
claims.

`hosting/vercel/tests/cloud.test.mjs` runs the actual Vercel handlers with an isolated conditional-write store and
sandboxed Chromium to check atomic commits, stale writers, a held server
acknowledgement, fresh-browser C resumption and lost-acknowledgement recovery.
