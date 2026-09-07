# Vercel — neohack.dev

The web UI lives in [`web/neohack.dev`](../../web/neohack.dev). Vercel serves the
website and its same-origin API. Gameplay runs in browser WASM; the server stores
journals and public observations without implementing game rules.

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
executes another game action. Content-addressed blocks, replay frames, captured
source and script notes are immutable objects referenced by small manifests.

Passkey registration uniqueness and credential counters share one atomic auth
document. Expired ceremonies and sessions are rejected and pruned on writes.
Projects and recordings are separate owner-scoped documents. Public run summaries
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

The published `board/index.json` is retained read-only as an additive historical
source. Initial summary construction batches its records by partition; it does
not perform thousands of per-run writes during a cold start. Existing records
are never discarded on deployment. The following rebuild is additive and does
not touch private journals or runtime pins:

```sh
node hosting/vercel/scripts/rebuild-ledger.mjs --apply
```

During play, public recordings only append to a separate browser IndexedDB outbox (500 frames / 32 MiB
per run). Uploads start on explicit flush (death screen or share/embed), not on
each movement. Transient uploads retry the same index/frame, including a lost response.
An exact duplicate is acknowledged without appending twice; a changed duplicate
is rejected. Queue exhaustion or access/sequence refusal is visibly reported and
retains pending frames. Browser data removal can still delete unsynced frames.

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

### Direct public replay delivery

Public replay playback makes **no dynamic function requests**. The static
/replay-config.json gives the public Blob origin. The viewer reads
replays/<id>/manifest.json and its relative chunks/<hash>.json files directly
from that origin, including on a cold load. Upload functions publish those files
at recording time. Chunks are create-only and content-addressed; the latest
manifest advances with ETag compare-and-swap after every referenced chunk exists.
A losing older publisher cannot roll it back. Manifest caching lasts 60 seconds;
immutable chunks cache for one year. Private recordings and resumable journals
remain in the separate private store and retain authenticated access.

Before deploying:

- Deployment provisions a dedicated **public** Vercel Blob store for public
  observations when replay configuration is absent. Its project-specific name
  makes retries reuse the same store. A production-only PUBLIC_REPLAY connection
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

Recording writes acknowledge only after publication. If publication fails after
its private recording commit, exact upload retries and authenticated writer
reconciliation retry publication. Browser playback does not provide a fallback
through the API. Verify in the browser Network panel that replay requests go
straight to the public Blob origin; the regression test blocks every /api/
request while playback still starts and advances.

Account owners can POST {"public":true} to /api/account/runs/:id/publish through
the account UI. Session ownership and same-origin checks precede publication.
The server reserves a separate public ID, projects only observed replay fields,
publishes static files, and adds the run to the ledger. Private source and script
notes are not exported. Future frame uploads preserve the selection; publication
failures do not invalidate a successful private recording commit. The account
page displays publishedCount and allows an explicit retry.
