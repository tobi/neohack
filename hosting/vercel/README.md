# Vercel — play.neohack.dev

Push to `main` deploys **both**:
- Cloudflare Workers → https://neohack.dev
- Vercel → https://play.neohack.dev

Journals stay on Cloudflare Durable Objects. Vercel serves the client, Web
Analytics, and optional Blob-backed `/api/runs` stats.

```sh
set -a && source /home/tobi/src/homelan/.env && set +a
npm install
npm run deploy
```
