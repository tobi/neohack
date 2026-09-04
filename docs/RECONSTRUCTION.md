# Legacy input-log reconstruction

New games already produce public perception recordings. Old input-only histories
can now be **explicitly reconstructed** into a separate, read-only archive.

A reconstruction is **not a verified original recording**. Even when every stored
input ID matches and the final summary agrees, old logs did not capture all
original observations, calendar state, or runtime options. The archive retains
that warning in every checkpoint and in its run metadata.

## Browser flow

1. Open the run library.
2. Select an entry marked **Legacy input log · click to reconstruct**.
3. Confirm the unverified reconstruction warning.
4. Wait for the isolated worker to finish, then select **Review reconstruction**.

Replay links can include `?run=ARCHIVE_ID&frame=FRAME_NUMBER`; opening one is
read-only and seeks directly to that checkpoint. The address bar follows the
selected remote frame.

The source run must not be owned by another live bridge. Save/leave it first.
The conversion is a management operation, not a game action. Normal playback,
seeking, importing public recordings, and camera controls never start an engine.

## Operator flow

```sh
bun tools/reconstruct-run.ts /path/to/legacy-sessions source-run-id
# Optionally copy the completed public archive into another run library:
bun tools/reconstruct-run.ts /path/to/legacy-sessions source-run-id \
  --publish-to ./sessions
```

The utility uses the same sandboxed worker as the browser. It does not overwrite
the source or silently substitute the current engine. Runtime run data remains
excluded from Git.

## Isolation and validation

Web/CLI management requires Linux **bubblewrap** and **prlimit**, with user/PID/
network namespaces available. There is no unsandboxed fallback.

- One conversion runs at a time per management service. It uses a dedicated
  bridge/process, not the live game's request queue.
- Only the stored input stream, pinned executable, and static `nhdat`, `sysconf`,
  `symbols`, and `license` files enter the sandbox read-only. Runtime saves,
  bones, blobs, unrelated home files, and other runs are not exposed.
- A fresh scratch playground is built. The original playground is never used
  as the replay working directory.
- The source lease inode is shared with the normal ownership protocol. Old runs
  may gain a `.lease` control file; original run-data bytes are not overwritten.
- The worker has no host network, a cleared environment, limited address space
  and CPU, a wall-clock deadline, and input/output size limits.
- Historical shell/suspend/debug commands are rejected conservatively.
- NDJSON framing, duplicate keys, initialization order, numeric IDs and an
  explicit seed are checked before starting an engine. Each response ID is then
  matched to the pinned engine's actual pending input.
- Only stored answers are supplied. No new movement policy or automatic answers
  are invented during reconstruction.
- Publication happens after the sandbox exits. Files must be regular files;
  symlinks are rejected. The complete index and all public frames are validated
  before the archive is renamed into the run library. Scratch data/executables
  are discarded, and failed jobs are never published as complete archives.

Some legacy binaries embed an absolute `SYSCF_FILE` path. The worker mounts only
the captured sysconf file at those literal aliases, not the surrounding host
home/playground. That is a compatibility mapping, not access to current data.

## Format and provenance

The output uses `neonethack.perception`, version 1: independent observation
checkpoints plus ordered public events. It adds `response.provenance`:

- `kind: "reconstruction"`
- `sourceSessionId`
- `verification: "unverified"`
- `readOnly: true`
- input, engine, and nhdat fingerprints
- stored-answer counts and whether the captured input stream was consumed
- an explicit description of the missing historical evidence

The fingerprints currently use FNV-1a for artifact identification. They are not
cryptographic signatures or an authenticity guarantee. `complete` means the
captured answer stream was consumed; it does not mean historical equivalence
was proved.

Legacy prompts are displayed as read-only historical `shown` events. Their
terminal encodings are not exported as controls. A derived archive cannot be
resumed or overwritten as an interactive game.

## Management endpoints

- `POST /runs/:id/reconstruct` with `{ "confirm": true }` starts a job.
- `GET /reconstructions/:jobId` reads its status.
- Completed outputs use the existing read-only `/runs/:id/index`, `/frames`,
  and `/export` endpoints.

Mutations enforce the same explicit origin policy as MCP. Local data routes also
validate Host names to prevent simple DNS rebinding. Reverse-proxy origins must
be explicitly listed in `MCP_ALLOWED_ORIGINS`. These controls are **not**
multi-user authentication; the service is still intended for a trusted owner.

## Verification

`mcp/tests/reconstruction.test.ts` covers actual engine reconstruction, source
byte preservation, leases, invalid histories, missing engines, ID divergence,
and read-only output. `mcp/tests/reconstruction-worker.test.ts` exercises the
sandbox, denied source writes, hidden unrelated/future data, network isolation,
unsafe publication artifacts, no fallback, and timeout cleanup.

`client/tests/reconstruction-browser.ts` checks the explicit confirmation,
job UI, provenance banner, and read-only playback. It requires an isolated
`BROWSER_SESSIONS_DIR` served by `APP_URL`.

The original seed-904 bot history was reconstructed into 4,002 checkpoints.
Its final T=3640, position (17,3), HP 38/38, XL 3, AC 6, and gold matched the
retained final digest. This is useful corroboration, **not full-trace
verification**, and its archive remains labeled unverified.
