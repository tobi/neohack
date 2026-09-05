# neohack.dev

Static pixel client + Cloudflare Worker. The engine still runs in the browser
(WASM). Durable Objects only store opaque journals and public run summaries.

WebMCP stays browser-mediated. Agent tools use the same WASM journal as human
input; after each local fsync the worker replicas that journal to a Vault DO.
There is no HTTP MCP that executes game rules.

Push to `main` deploys via `.github/workflows/deploy.yml`.

```sh
set -a && source /home/tobi/src/homelan/.env && set +a
npm install
npm run deploy
```
