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
truncate, skip, or overwrite damaged bytes. Explicit operator salvage into a
preserved/copy-based history is still future work. Keep the original and any
backups; do not "fix" this by deleting request reservations or starting a new
game with the same ID.

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

Full private-sidecar/input-journal recovery, explicit copy-based salvage, and
filesystem/power-loss fault coverage beyond these injected boundaries remain
open. None of this upgrades historical reconstruction into verified history.
