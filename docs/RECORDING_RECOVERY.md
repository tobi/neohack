# Recording durability and recovery

A run has two different journals:

- `input.log.jsonl` and `requests.seen.jsonl` govern engine replay and request
  reservations. Missing receipts are uncertainty, never permission to execute
  an intent again.
- `perceptions.jsonl` contains LF-committed public checkpoints. Its index,
  `run.json`, and the sidecar's frame counter are derived caches, not authority
  for whether a checkpoint exists.

## Commit order

The C owner validates the checkpoint stream before accepting new input, and
holds the run lease through data, index and metadata commits. After the data
line is flushed and fsynced, its sequence is consumed **even if** an index or
metadata write fails. Rebuilt indexes and metadata use temporary files, atomic
rename and directory fsync. New directory entries are synced before use.

On resume, complete journal lines reconcile stale frame/revision counters and
rebuild a missing, torn or incorrect index. Existing checkpoint and input bytes
are not rewritten. A counter claiming more committed frames than the journal
contains fails closed instead of silently rewinding history.

An I/O failure returns live `recording` diagnostic metadata, for example:

```json
{"recording":{"status":"degraded","message":"...","requiresResume":true}}
```

The deed's outcome and observation still describe what happened. **Do not
repeat it with a new request ID.** Retry the same ID or inspect/resume after
fixing storage. `recording` is current health information, not part of the
immutable semantic receipt; it can change when a receipt is retrieved later.
The browser disables further deeds while reporting degraded recording health.

## Missing boundaries versus missing bytes

New frames carry a request-reservation watermark, `requestsThrough`. If replay
resumes past requests that had no checkpoint, the next captured boundary has
`gapBefore:true`. This means an earlier request boundary was not recorded; it
does not claim that the request executed or manufacture its old observation.
The notice remains visible in review and export/import. A receipt lost from the
archive and evicted from the hot cache remains `incompleteRequest` forever
unless actual receipt evidence is recovered; the reservation is retained.

A torn or corrupt checkpoint journal is different. The native writer refuses
to append to it or start a resume engine. It does **not** automatically discard,
truncate, skip, or overwrite damaged bytes. The explicit operator utility below
can preserve a full evidence copy plus a read-only prefix export. It does not
repair a live world. Keep the original and any backups; do not "fix" this by
deleting request reservations or starting a new game with the same ID.

## Private metadata and input integrity

`meta.json` carries semantic operation state and recent receipts; it is not an
optional cache that can be replaced with defaults. New sidecars identify their
format/version/session, `inputBytes` boundary and `boundaryComplete` state.
Pending input context is fingerprinted for consistency (not authentication).
Legacy well-formed sidecars remain supported, without pretending they captured
new boundary metadata.

The owner writes sidecars through unique temporary files, file fsync, atomic
rename and directory fsync. Failures latch until explicit recovery; later
answers are not sent while durability is unresolved. A missing, malformed,
duplicate-key, out-of-range, inconsistent or unsafe sidecar fails closed before
engine startup. Invalid bytes are not replaced. Recent receipts are accepted
only with matching run/request identities. Metadata changed outside its owner
is also rejected instead of overwritten.

Input history must be complete LF-terminated UTF-8 JSON, beginning with exactly
one initialize/new_game pair and an explicit seed. It is bounded to 128 MiB,
1,000,000 records and 64 KiB per record. Partial reads/allocations never become
partial replay histories. No append is made to changed or invalid input bytes;
file and directory durability precede sending an answer to the engine.

Resume validates every answer's id, shape and known offered values against the
actual waiting input (command indices, nonempty yn choice sets, menu options
and selection cardinality). Explicit cancellation remains cancellation; empty
choice domains are not guessed. Menu replay uses the same accelerator-bearing
options the current core offers; legacy rows without that information are not
silently promoted to selectable items. It
forbids shell/suspend/debug replay, and has a two-minute inner deadline. Mismatch
or early exit aborts the owned child rather than feeding an engine default or
publishing a partial replay. Pending game decisions are aborted rather than
implicitly answered when an interactive handle is retired.

If the input history outlasts its private semantic checkpoint, its completion
flag is unfinished, or the captured pending context no longer matches, resume
returns `recoveryRequired`/unknown with the resulting observation but no invented
decision. New deeds are blocked. End the handle or inspect archives; do not clear
flags/reservations to force continuation. This is conservative uncertainty, not
a complete automatic repair strategy. A journal shorter than its committed
private boundary is rejected before an engine starts.

Storage health appears as a live `storage` diagnostic, separate from immutable
deed receipts. The viewer preserves the warning when switching to review and
back, and disables answers/deeds until recovery. A complete logged answer whose
fsync failed may survive and be replayed after storage is fixed; its semantic
boundary remains explicitly uncertain rather than being claimed completed.

## Explicit preserved-copy salvage (Linux operator CLI)

```sh
bun tools/salvage-run.ts SESSIONS_DIR RUN_ID NEW_BUNDLE_DIR --confirm
```

Save/retire the source owner first. `NEW_BUNDLE_DIR` must not exist and must be
outside the session root. The utility requires the existing regular `.lease`
and takes its exclusive lock for the entire copy, including after the flock
helper exits. Missing/busy leases are refused; no lease or other file is
created in the original. No engine, shell command from the recording, or
reconstruction worker is executed.

The bundle contains:

- `evidence/`: every source file and directory, including damaged journals,
  private sidecars, request reservations, pins and saves. File contents are
  byte-preserved, independently copied, fsynced, and made non-executable/read-only
  (0400); original modes and SHA-256 hashes are recorded in the manifest.
- `review.nh-run.jsonl`: only complete validated checkpoints up to the first
  failure, preceded by the existing warning-preserving recording manifest.
  Frames, identities, gap markers and reconstruction provenance are not rewritten.
  No playable export is invented if there are zero valid frames.
- `manifest.json`: the fsynced completion marker, published only after the
  evidence, export and directories have been flushed. It lists source identity,
  file hashes, integrity and the explicit `liveRecovery:false` limitation.
- `INCOMPLETE.json`: a persistent staging notice. Without a complete manifest,
  or if `FAILED.json` exists, treat the bundle as incomplete. Failed copies are
  retained for diagnosis; neither original damage nor reservations are erased.

Open the review file through **Import recording**. Browser-local import remains
limited to 128 MiB; larger prefixes still need paged review of the original
read-only archive (a standalone paged bundle viewer is not implemented).
The source stays damaged and still refuses native resume. This command does
not install or publish a new live session, reconcile uncertain execution,
rewrite private metadata, or make reconstruction historically verified.
SHA-256 identifies copied bytes, not their authenticity.

Copying is bounded to 10 GiB total, 8 GiB per file, 20,000 entries and 32 directory
levels. Files/directories are opened through pinned directory descriptors;
symlinks and nonregular files are rejected. Journals/metadata require single
links. The one exception is the native root `engine` pin, which intentionally
shares a versioned cache inode; its copy is an independent non-executable file.
A final inventory/stat comparison rejects detected source changes outside the
cooperating lease. This is not a filesystem snapshot against a hostile owner.
A complete healthy checkpoint stream needs no damaged-prefix salvage and is
refused without creating a bundle.

## Read-only review

`/runs/:id/index` derives a bounded index from complete checkpoint bytes rather
than trusting the stored index. `/frames` serves only that validated prefix.
Missing/stale library metadata is reconstructed in memory from its last frame.
GET/HEAD never repair disk files, take over a game, or import/start an engine.

The index/page replies include `integrity`: state (`complete`, `partial`, `corrupt`, or
`limited`), valid and total bytes, complete frame count, and marked gaps.
An incomplete tail can also be an active write; reopening obtains a fresh
snapshot. Validation stops at the first malformed or discontinuous frame.
It does not skip damage and pretend later checkpoints form a complete history.

- Normal export contains the validated prefix. For damaged sources, it starts
  with a `neonethack.recordingManifest` v1 line containing the integrity notice,
  followed by normal perception frames. Import preserves that notice.
- `/runs/:id/export?raw=1` preserves the raw original bytes, including damage.
  This is for backup/diagnosis, not a claim that the file is playable.
- Healthy exports remain byte-for-byte checkpoint streams. History gap markers
  remain part of their frames.

Regular single-link files and direct run directories are required; symlinks
cannot redirect archive/lease access. Review is bounded to 8 GiB / 100,000
checkpoints, 8 MiB per checkpoint and 32 MiB per page, with two concurrent scans
and a bounded snapshot cache. Larger or damaged remainders are not silently
accepted. These checks establish structural consistency, not authenticity or
historical equivalence.

Reconstruction publication uses **strict stored-index validation**, not the
read-only recovery fallback. Corrupt or partial worker outputs are still
rejected, and reconstructed provenance remains unverified/read-only.

## Verified scope

`mcp/tests/archive-recovery.test.ts` exercises real engines plus a test-only
Linux fsync interposer (never linked into production). It covers cache commit
failures, counter lag, torn checkpoints, poisoned old receipts, reservation
watermark gaps, and no replay of an evicted missing receipt. The browser test
uses only its own newly created/saved run in an isolated `/tmp` root, retains
the damaged evidence, and restores that test fixture afterward.

`mcp/tests/salvage.test.ts` checks real run preservation, lease exclusion and
retention, unsafe entries, bounds, source changes, duplicate checkpoints,
unparseable private state, zero-frame evidence, and non-execution of pins.
`client/tests/salvage-browser.ts` imports and seeks a real salvaged prefix with
zero engine traffic. Native and read-only scanners reject duplicate checkpoint
keys rather than disagreeing about which value is authoritative.

Automatic private-state recovery, continuation from genuinely uncertain
boundaries, large paged bundle review, and filesystem/power-loss fault coverage
beyond the injected boundaries remain open. None of this upgrades historical
reconstruction into verified history.
