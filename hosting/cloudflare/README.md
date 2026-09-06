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

The repository’s deployment workflow builds from source on pushes to `main`.
Configure Cloudflare credentials through GitHub Actions secrets, and update the
account and domain in `wrangler.toml` for your own deployment. Never commit tokens.
