# Website hosting

The [live game](https://neohack.dev) serves the pixel client and the library’s WASM
package. NetHack and its semantic driver execute in the browser. Cloudflare
Durable Objects store opaque journals and run summaries; they do not execute
game rules or expose an HTTP gameplay API.

WebMCP uses the same C engine and durable local journal as keyboard and touch
input. Cloud replication runs in the background. See the
[cloud journal design](../../lib/neonethack/docs/CLOUD_SAVES.md).

## Development

Build the library and [pixel client](../../example/pixel-bun/README.md#run-locally),
then run from this directory:

```sh
bun install --frozen-lockfile
node scripts/stage.mjs
bunx wrangler dev --local
```

After building the library and pixel client, run `npm test` here to exercise
real local Durable Objects and sandboxed Chromium with temporary stores.

## Deployment

The repository’s deployment workflow builds or reuses verified artifacts on pushes to `main`.
Configure Cloudflare credentials through GitHub Actions secrets, and update the
account and domain in `wrangler.toml` for your own deployment. Never commit tokens.

### Runtime packages

New adventures select `/runtime/wasm/current.json`. Each adventure records the
selected package hash, and its worker, WASM, data and helpers load together from
`/runtime/wasm/<sha256>/` with immutable caching. Resuming uses the recorded
package, including when another package is current. Development saves without
that identity are not upgraded.

Deployment first checks the hosted compiler-input registry. The key includes C
sources, engine data, generated dispatch, build recipes and pinned toolchain
versions; UI, TypeScript, JS worker glue, docs and tests do not trigger C rebuilds.
A hit restores and verifies compiled bytes before rebuilding the current JS
package. A miss installs the toolchain and compiles. Published packages remain
in subsequent asset manifests; Wrangler uploads missing content hashes only.
The generated registry/cache and runtime binaries are deployment artifacts, never
Git source. Failed integrity checks stop deployment. A missing registry on the
first deployment bootstraps an empty registry.

After local builds, `npm run deploy` also restores the published registry before
staging, so a manual deployment retains the same immutable packages as CI.

### Adventure ledger and errors

`/dashboard` reads `/api/stats`: all-run totals, top 100 runs ordered by
ascension / peak experience level / turns, class counts, and 14 UTC days of error
category counts. The run board is browser-reported, not a verified competitive
score. The legacy `/api/runs` read remains the latest 200 summaries. No historic
journal scanning or replay is performed; old runs acquire richer summaries when
played again. Terminal status and larger turn counts cannot regress on stale posts.

Worker observability records server exceptions and diagnostic categories. The
client additionally POSTs `/api/errors` in the background, once per category and
package per page visit (maximum 10 reports). Only allowlisted categories and a
package hash survive ingestion; raw messages, stacks, names, save links and vault
IDs are excluded. Offline/unloaded clients cannot report; counts are reports,
not unique affected users. The public dashboard refreshes every minute. Error
aggregates expire after 14 days; run summaries remain until explicitly removed.
