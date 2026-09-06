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
exclude vault keys, account IDs, private notes and source. Diagnostics retain only
bounded categories, build hashes and counts, never raw errors or bookmarks.

The private Blob implementation is tested through the same storage interface as
an isolated CAS fixture; tests run the actual API and staged browser client,
including real browser passkeys, fresh-browser resume and competing writers.
Hosted Blob and domain bindings still require the production smoke check. Old
development data on retired hosting is not migrated.
