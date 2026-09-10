# Vercel — neohack.dev

The web UI lives in [`web/neohack.dev`](../../web/neohack.dev). Vercel serves the
website and its same-origin API. Gameplay runs in browser WASM; the server stores
compressed protocol input archives without implementing game rules.

## Deployment

GitHub Actions builds the library and web UI, stages this directory, and deploys
it on pushes to `main`. Direct Vercel Git deployments are disabled so an unbuilt
checkout cannot replace the staged site. The CLI uploads `hosting/vercel` as the
project root, so leave Vercel’s Root Directory override empty. Use Node 24 and
assign `neohack.dev` and `play.neohack.dev` to that same project. Set the repository secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` to that project. Production pages must be publicly accessible.

Connect a **private Vercel Blob** store to the project so production functions
receive `BLOB_READ_WRITE_TOKEN`. Missing storage produces HTTP 503, never a false
"saved" acknowledgement. No storage token is included in browser assets.

From the repository root, after building the matching WASM runtime:

```sh
npm run --prefix lib/neonethack build
bun install --frozen-lockfile --cwd web/neohack.dev
bun run --cwd web/neohack.dev build
bun install --frozen-lockfile --cwd hosting/vercel
npm test --prefix hosting/vercel
# With Vercel authentication and project selection configured:
npm run --prefix hosting/vercel deploy
node hosting/vercel/scripts/smoke.mjs https://neohack.dev
```

`stage.mjs` retains verified content-addressed runtime packages and writes a
`current.json` pointer for new games. CI restores matching compiler artifacts
from the hosted registry before deciding whether compilation is needed. Existing
runs retain their exact runtime pin. A broken package fails staging; there is no
unpinned fallback. Vercel deduplicates uploaded static files by content.

`vercel.json` defines extensionless routes, API routing, sandbox policy, component
CORS and runtime caching. Its build command checks the staged output before
publication. CI checks the production root, dashboard, workshop and APIs after
deployment, so an empty deployment or wrong domain assignment fails the job.

## Storage and privacy

Private Blob documents use ETags for conditional updates and create-only initial
writes. Contending writers re-read before retrying a pure storage update. Journal
commits compare the base revision and exact request digest; uncertainty never
executes another game action. Compressed input chunks and checkpoints are public,
unlisted immutable objects. Captured script source and notes stay private. The
retained block and frame formats support previously published runs.

Passkey registration uniqueness and credential counters share one atomic auth
document. Expired ceremonies and sessions are rejected and pruned on writes.
Projects and account-to-run associations are separate owner-scoped documents. Public run summaries
exclude vault keys, account IDs, private notes and source. Diagnostic application logs contain only bounded categories, build hashes,
route templates, response status and duration, never raw errors or bookmarks.

The private Blob implementation is tested through the same storage interface as
an isolated CAS fixture; tests run the actual API and staged browser client,
including real browser passkeys, fresh-browser resume and competing writers.
Hosted Blob and domain bindings still require the production smoke check. Old
development data on retired hosting is not migrated.

## Error pages

Static `400.html`, `404.html` and `500.html` pages carry their own artwork and
styles. They need no runtime or asset downloads. Missing static URLs use the 404
page. Handled API failures use these pages for HTML document requests while
keeping their actual status; ordinary fetch clients continue receiving JSON.
Vercel automatically uses static error pages for platform crashes/timeouts only
on Enterprise plans. On Hobby, a failure before our handler starts still uses
Vercel’s platform page. No paid-plan change is made by this repository.

### Ledger preservation and outage recovery

Deployments must retain the production Blob store and its `board/index.json`.
A failed read is an outage, never an empty ledger or permission to overwrite it.
The health endpoint checks an actual storage read; the dashboard retains its last
loaded rows and shows an explicit error when storage is unavailable. Fresh local
adventures remain available without replacing unreachable cloud-only runs.

The one-time relocation recovery tool reads the original `board/runs.json` and
adds only IDs missing from `board/index.json`. Existing records and diagnostics
win; neither the source ledger nor private saves/accounts are changed. Run with
production `BLOB_READ_WRITE_TOKEN` supplied through the environment:

```sh
node hosting/vercel/scripts/recover-ledger.mjs          # counts/hash only; no writes
node hosting/vercel/scripts/recover-ledger.mjs --apply  # conditional atomic merge
```

On 2026-09-06, recovery restored 1,573 missing records (1,665 total at verification).
Repeated execution reports zero additions. Retain the original ledger as evidence;
this tool is operational recovery, not a game-save compatibility layer.

### Public ledger storage

New run records live independently at `ledger/runs/<id>.json`. Thirty-two
partitioned indexes feed bounded top-run/statistics summaries; historical diagnostic counts
live in separate daily documents. Statistics read those summaries rather than
sorting the complete ledger on each request. Updates use conditional writes and
preserve terminal and highest-progress records. Run records remain authoritative
if a summary update fails; retrying or rebuilding repairs the projection.

Each partition summary also retains its 200 latest updated runs and three leaders
per metric (peak hero level and depth) per UTC day for the current seven dates.
`/api/stats` merges these bounded lists into a global latest 200 and today's /
last-seven-days records. The windows select runs by their latest `updatedAt`,
not by creation or achievement time. Missing/nonpositive/noninteger scores are
omitted; accepted updates retain known peak level and depth. Expired dates are
filtered at read time even when no new runs arrive. A summary with an older
projection format is refreshed once from its existing partition using conditional
writes. Authoritative run records, journals and runtime pins are untouched;
normal statistics requests still read only the 32 summaries.
The welcome page requests `/api/stats?view=count`, which returns only `{runs}`.
Successful public counts cache for 60 seconds with five minutes of stale-while-
revalidate; failed storage reads keep the normal uncached error response.

The published `board/index.json` is retained read-only as an additive historical
source. Initial summary construction batches its records by partition; it does
not perform thousands of per-run writes during a cold start. Existing records
are never discarded on deployment. The following rebuild is additive and does
not touch private journals or runtime pins:

```sh
node hosting/vercel/scripts/rebuild-ledger.mjs --apply
```

New runs append protocol requests locally and upload compressed immutable batches
at five seconds idle / thirty seconds active. No per-turn observation archive is
written. [CLOUD_SAVES.md](../../lib/neonethack/docs/CLOUD_SAVES.md) owns the input
format, checkpoints, recovery and static playback contract. Earlier published
frame recordings remain readable; their endpoints are retained for those saves.

### Vercel logs and observability

Operational diagnostics are private to the Vercel project. `/dashboard` and
`/api/stats` expose adventures, not error feeds. No new diagnostic aggregates are
written to Blob; existing historical documents are preserved without being read
by the dashboard.

In the Vercel project, open **Logs**, select the production environment, and
filter for `request_failed` (error level) or `client_diagnostic` (warning level).
Application logs are single JSON records. Failed API responses include a route
**template**, method, status, duration and a bounded failure category; Vercel adds
invocation/deployment correlation. Routes never include vault or run identifiers
in application log fields. Request bodies, headers, raw exceptions and user
content are not logged by this application. Vercel's own request metadata is
managed separately by the platform.

Browser reports are untrusted category/package reports, deduplicated per page
visit. They reach the function's logs even when Blob is unavailable, but offline
reports can be lost. A report is not an affected-player count or a server 5xx.
Use **Observability** for function invocation/error rates and latency, then Logs
for the corresponding failures. Log retention, alerts and drains depend on the
project's plan/configuration; this code does not enable paid features or change
account settings.

See [Runtime Logs](https://vercel.com/docs/logs/runtime),
[structured logging](https://vercel.com/kb/guide/add-structured-application-logs-to-vercel-functions)
and [Observability](https://vercel.com/docs/observability).

### Run attribution

Run metadata permanently records `webmcpAutomated` when WebMCP participates in
creation/control, alongside optional caller-supplied `harness_name` and `model_name`
(creation fields allow 120 UTF-8 bytes each). These labels are attribution, not verified identity.
Directory, authoritative ledger records, shards and summaries retain this evidence
across human/script takeover and delayed metadata. Late attribution may enrich a
record without replacing its newer turn, ending or runtime pin. The ledger badge
uses text-only labels in its tooltip; no private account/vault data is added.

### Direct public replay delivery

Public replay playback makes **no dynamic function requests**. The static
/replay-config.json gives the public Blob origin. The viewer reads
replays/<id>/manifest-<hash>.json and its relative chunks/<hash>.gz input files directly
from that origin, including on a cold load. Upload functions publish those files
at recording time. Chunks are create-only and content-addressed; the latest
immutable playlist is published after every referenced chunk exists. The
`manifest.json` discovery alias advances with ETag compare-and-swap, but may be
cached; exact upload acknowledgements and embed links never depend on its age.
Publishers read the current ETag with Blob's management `head()` API, then read
the authoritative private run head before attempting the conditional write.
Public `get({useCache:false})` still reads cached content and cannot supply this
token reliably. A losing older publisher cannot roll it back. Manifest caching lasts 60 seconds;
immutable chunks cache for one year. Replay links are unlisted and readable by
anyone who has the link. Upload authority, account associations, script source and
notes stay in the separate private store. Checkpoints use immutable hash-named
objects with the same static delivery; they are derived caches, not log authority.

Input upload batches are packed by the writer into size-bounded playback files:
2 MiB decoded / 1 MiB gzip / 8,192 records per file (upload batches retain their
smaller 1 MiB decoded / 512 KiB gzip limits). A small creation chunk
starts playback early. Similar-sized suffix chunks merge while a run is active;
conclusion consolidates the last eight chunks. This keeps read counts short
without rewriting a growing full-size tail on every five-second upload. Original
upload hashes/ranges remain in the packed files for exact retries; publication
and CAS guards are unchanged. Old immutable manifests/chunks are retained.

The **Compact public input replay archives** workflow inventories concluded runs
by default. Select `apply` to pack them, optionally selecting one public run ID
and a batch limit. It uses existing stores, preserves pins/checkpoints/ownership
and never deletes prior public objects. Local operator equivalents are:

```sh
node hosting/vercel/scripts/stage-validator.mjs
node hosting/vercel/scripts/compact-input-replays.mjs --run PUBLIC_RUN_ID
node hosting/vercel/scripts/compact-input-replays.mjs --run PUBLIC_RUN_ID --apply
```

Compaction is explicit writer/maintenance work. Watching a replay never invokes
it or downloads inputs through a dynamic API.

The **Audit and compact all ledger replays** workflow covers every ledger entry,
including historical public frame recordings. Its default is read-only. `apply`
repairs interrupted publication where the public source still exists, verifies
every frame or every input with its original WASM engine, then compacts verified
archives. Legacy frame files stay ordinary `{frames:[...]}` JSON, with a small
first scene and subsequent files bounded to 2 MiB / 256 frames. The input format,
pins, checkpoint references, exact upload receipts and old objects are preserved.
An identical ordered stream hash is required before and after compaction.
The checker batches inputs through the current worker with the original engine;
every receipt and RNG boundary is still verified inside that worker. The frame
audit calculates the packing size during its first read, skips layouts that
would not reduce file count, and does not redownload an unchanged playlist.
Changed playlists are verified through their exact hash-named immutable manifest,
then checked against the current source head. A cached older `manifest.json`
response cannot substitute for verification of the newly packed files.

The sanitized workflow artifact lists each public ID, verdict, stream hash and
file counts. Missing or invalid recordings lose their replay link, never their
ledger entry, scores, saved games or cached tale. Network/authentication failures
are inconclusive and leave availability unchanged. Results bind to source heads
and versioned `ledger/replays/<id>.json` records: stale metadata and summary
rebuilds cannot revive a known broken replay. Successful first publication can
repair a missing recording; a corrupt prefix requires another successful audit.
Publication is recorded even if it precedes the run's ledger metadata. Merely
having a private input head or a recording filename does not establish playback.
The audit is a snapshot of the selected ledger; live runs changing during the
check are reported separately and can be checked again without deleting data.

```sh
node hosting/vercel/scripts/audit-public-replays.mjs --report replay-audit.json
node hosting/vercel/scripts/audit-public-replays.mjs --apply --run PUBLIC_RUN_ID
```

These operator commands require the existing private/public stores configured;
the production workflow loads credentials internally and never puts them in its
report. It performs no LLM generation or account-private recording publication.

Staging also generates the offline service worker's exact asset list and copies
the shared archive validator into `.generated/`, inside Vercel's upload root.
Deploy the staged folder; do not omit its generated function dependency. API and
authenticated responses never enter service-worker caches.

Before deploying:

- Deployment provisions a dedicated **public** Vercel Blob store for public
  observations when replay configuration is absent. Its project-specific name
  makes retries reuse the same store. A production-only PUBLIC_REPLAY_BLOB connection
  creates PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN; setup adds PUBLIC_REPLAY_ORIGIN.
  Existing complete configuration is reused; conflicting or partially configured
  external stores require operator review. Setup never changes a store's access,
  replaces credentials, or touches the private BLOB_READ_WRITE_TOKEN.
- Deployment reads the public origin from the Vercel production configuration
  and confirms the dedicated token is configured without decrypting that token.
  An optional GitHub PUBLIC_REPLAY_ORIGIN variable must agree. Deployment refuses
  to proceed with missing or mismatched configuration. Tokens never enter browser
  configuration or staged assets.
- Publish already-public historical recordings once, with both store tokens and
  the public origin provided securely through the environment:
  node hosting/vercel/scripts/publish-replays.mjs (inventory only), then add
  --apply to publish. It never reads private account recordings or deletes data.
  Re-running skips published prefixes and repairs interrupted publication.
  The manual **Publish existing public replay recordings** Actions workflow does
  this with production credentials held only in the runner process. It defaults
  to inventory; select `apply` to publish. It never changes the private store.

Recording writes acknowledge only after publication. If publication fails after
its private recording commit, exact upload retries and authenticated writer
reconciliation retry publication. Browser playback does not provide a fallback
through the API. Verify in the browser Network panel that replay requests go
straight to the public Blob origin; the regression test blocks every /api/
request while playback still starts and advances.

For older published frame recordings, account owners can POST {"public":true} to /api/account/runs/:id/publish through
the account UI. Session ownership and same-origin checks precede publication.
The server reserves a separate public ID, projects only observed replay fields,
publishes static files, and adds the run to the ledger. Private source and script
notes are not exported. Future frame uploads preserve the selection; publication
failures do not invalidate a successful private recording commit. The account
page displays publishedCount and allows an explicit retry.

### Dungeon chronicles (AI retellings)

`GET|POST /api/runs/:id/chronicle` serves a one-page comic retelling of a
concluded public run, written by Muse Spark 1.3 through
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway). The death screen and
each run's page (`/replays/:id`, where every ledger Show replay link leads)
offer **Tell the tale** for runs that reached
dungeon level 3 and experience level 2 and ended in death (eligibility mirrors
`examples/chronicle` and is checked against the ledger record first). Generation
replays the published input archive with its exact pinned WASM core, engine and
data inside the function. Current host workers process batches of up to 128
inputs and return each verified boundary's compact narration evidence, preserving
the collector's exact model input. This uses the same module closure as the CLI
(including worker entrypoints, staged into
`.generated/chronicle/`), then makes **one** paid model request with the
markdown journal (up to about 70k tokens). The validated story, its dotted
encyclopedia segments and the glossary are cached as the public object
`chronicles/<id>/story.json`; the ledger entry gains `chronicleAvailable`,
which draws the scroll icon beside *Show replay*. A `POST` with
`Accept: application/x-ndjson` watches the work as it happens: one JSON object
per line with replay progress (`{"status":"replaying","done":n,"total":m}`),
`{"status":"writing"}`, the story text as the model writes it (`{"delta":…}`),
`{"status":"storing"}` and finally the stored document (or
`{"available":false,"error":…}`). The job is registered with `waitUntil` and
finishes, validates and stores the tale even if the reader leaves; a plain
`POST` waits and returns the document as before. Page views only read the
cached object; nothing is regenerated on view. Because the story path is read
through the public Blob CDN while the tale is still being told, the CDN may
briefly keep that not-found answer after the store completes; a public read
that misses therefore re-checks the management API and, when the object exists,
reads it under a revision-specific query so the first view after completion
sees the story. A `chronicles/<id>/pending.json`
claim keeps concurrent requests from paying twice (later callers receive 202
and poll), and a failed generation releases the claim without retrying
automatically. The archive holds inputs only, so the messages must be reconstructed
by the pinned engine and semantic core. Chunk prefetch and bounded parallel
runtime downloads reduce network waits; batching retains receipt/RNG verification
and never skips a story incident by jumping to a checkpoint.

Staging replaces the chronicle module directory on every build, including
literal worker entrypoints with multiline/trailing-comma URL syntax. A fresh
directory startup test and release validator guard against missing workers
being masked by files left from an earlier local build.

Each accepted generation logs one `chronicle_timing` record with its outcome,
admission/publication time, nested replay counts and stage times, model time to
first text and completion, validation, storage and total request duration.
`downloadWaitMs` includes chunk decoding and the wait remaining after prefetch;
`replayMs` includes verified worker execution and transfer, not pure engine CPU.
`modelFirstTextMs` is absent when no text delta arrived. Failed stages still emit
their elapsed time. No prompt, run capability, journal, story text or credential
is logged. Cache hits do not report another generation. Failures also log
`chronicle_failed` with a stage and error kind only.
The function is configured with a 300-second budget
and bundles `public/runtime/wasm/**` so the current engine package replays
without a network fetch; older pins are fetched from the site's own runtime
directory into `/tmp`.

No model key lives in this repository. The function authenticates with the
deployment's [Vercel OIDC token](https://vercel.com/docs/oidc) (the
`x-vercel-oidc-token` request header or `VERCEL_OIDC_TOKEN`), which AI Gateway
accepts directly. `scripts/chronicle-deploy-env.mjs` runs at deploy time and
enables the project's OIDC federation when it is off; an operator-managed
`AI_GATEWAY_API_KEY` in Vercel production is accepted as the alternative and is
never read or printed. Without either, the endpoint answers 503 before any
replay work.

Significant, verified improvements should be committed and deployed, followed by
production smoke checks, as requested by the project owner. Keep unfinished
changes outside the release candidate.

The retained block-store format uploads large commits as content-addressed parts of at most 256 KiB, then
submit a small final manifest. The server reconstructs and verifies the exact
commit before advancing its revision. Local pending data remains until an exact
acknowledgement; a lost response retries without duplicating input. Downloads
fetch a manifest and bounded blocks at a fixed revision. A concurrent update
rejects the read rather than mixing revisions.

Failed game entry emits `game_entry_failed` in Vercel Runtime Logs with a safe
category, entry kind (`boot`, `create`, `resume`), local-recovery preference and available
runtime hash. Each failed attempt is reported, rather than deduplicated per page.
The endpoint does not depend on Blob availability; client delivery remains best
effort when the network itself is unavailable. Filter these events in Vercel
Observability; they never appear on the public ledger.

Older block-store runs use one persistent backup-stream UUID per local browser store.
`/api/vaults/:vault?branch=:stream` stores its conditional manifest at
`vaults/:vault/copies/:stream.json`; existing shared `journal.json` remains intact.
Opening a cloud copy in a fresh browser restores its exact files and pin, then
starts a separate stream. The acknowledged stream ID travels in private adventure
metadata, not public ledger records. Initial copies upload all blocks; later
commits upload only changes. Conflicting pre-stream outboxes remain in IndexedDB
as `previous-copy`, alongside their former acknowledgement. No progress is merged
across two engine histories, and no deployment deletes an older copy.

Uploads run after five idle seconds or thirty seconds of continuous requests,
with bounded retries. Ledger/private adventure batches are additive and limited
to fifty entries; older or terminal progress cannot be downgraded. A failed
health probe never disables the uploader for the rest of the visit.

Public replays have shareable pages at `/replays/{run-id}`. The rewrite serves
`replays/index.html`; the player resolves static manifests through
`/replay-config.json`. An optional public ledger lookup supplies run totals and
the last-recorded date, and never gates playback. Account input recordings link
to the same page; older private frame recordings still require publication.
