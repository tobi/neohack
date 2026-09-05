// Static-only example server. No engine, game API, uploads or session storage.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(import.meta.dirname, '../../..');
const allowed = ['examples/wasm', 'lib/neonethack/dist', 'lib/neonethack/docs'].map(p => resolve(root, p) + '/');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.ts': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
export async function serveExample(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = await realpath(resolve(root, '.' + path));
      if (!allowed.some(base => file.startsWith(base))) { res.writeHead(404).end(); return; }
      const data = await readFile(file);
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Content-Length', data.byteLength);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const server = await serveExample(port);
  console.log(`http://127.0.0.1:${server.address().port}/examples/wasm/index.html`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
