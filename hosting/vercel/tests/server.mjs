import {publicReplayContext} from '../src/public-replay-store.ts';
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { handler } from "../api/index.ts";
import { storageContext, Conflict } from "../src/storage.ts";
const config = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
);
export class MemoryStorage {
  docs = new Map();
  revision = 0;
  async read(path) {
    return structuredClone(this.docs.get(path) ?? null);
  }
  async write(path, value, etag) {
    if (this.docs.get(path)?.etag !== etag) throw new Conflict();
    this.docs.set(path, {
      value: structuredClone(value),
      etag: String(++this.revision),
    });
  }
  async list(prefix) {
    return [...this.docs.keys()].filter((p) => p.startsWith(prefix));
  }
}
const publicStores=new WeakMap();
export function publicStoreFor(store){let publicStore=publicStores.get(store);if(!publicStore){publicStore=new MemoryStorage();publicStores.set(store,publicStore);}return publicStore;}
export function createTestHarness({ store = new MemoryStorage(), wrap = (fn) => fn() } = {}) {
  const publicStore=publicStoreFor(store);
  const root = resolve(import.meta.dirname, "../public");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if(url.pathname==='/replay-config.json'){res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*'});res.end(JSON.stringify({base:url.origin+'/replay-files/'}));return;}
      if(url.pathname.startsWith('/replay-files/')){const doc=await publicStore.read(url.pathname.slice('/replay-files/'.length));res.writeHead(doc?200:404,{'content-type':doc?.value instanceof Uint8Array?'application/gzip':'application/json','access-control-allow-origin':'*'});res.end(doc?.value instanceof Uint8Array?doc.value:JSON.stringify(doc?.value??{error:'not found'}));return;}
      if (url.pathname.startsWith("/api/")) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = new Request(url, {
          method: req.method,
          headers: req.headers,
          ...(["GET", "HEAD"].includes(req.method)
            ? {}
            : { body: Buffer.concat(chunks) }),
        });
        const response = await storageContext.run(store, () =>
          publicReplayContext.run(publicStore,()=>wrap(()=>handler(request))),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      let path = url.pathname;
      const rewrite = config.rewrites.find((r) => r.source === path || (r.source === "/replays/:id" && /^\/replays\/[\w-]{1,64}$/.test(path)));
      if (rewrite) path = rewrite.destination;
      if (path === "/") path = "/index.html";
      let file = resolve(root, "." + path);
      if (!file.startsWith(root + "/")) throw Error("Invalid path");
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      const headers = {};
      for (const rule of config.headers) {
        let pattern = rule.source
          .replace(":build([a-f0-9]{64})", "([a-f0-9]{64})")
          .replace(":path*", "(.*)");
        if (new RegExp("^" + pattern + "$").test(url.pathname))
          for (const h of rule.headers) headers[h.key] = h.value;
      }
      headers["Content-Type"] =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".json": "application/json",
          ".wasm": "application/wasm",
          ".css": "text/css",
          ".png": "image/png",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
        }[extname(file)] ?? "application/octet-stream";
      // Local test fixtures do not load external analytics.
      let body = await readFile(file);
      if (extname(file) === ".html")
        body = Buffer.from(
          body
            .toString()
            .replace(/<script[^>]+src="\/_vercel\/[^"]+"[^>]*><\/script>/g, ""),
        );
      res.writeHead(200, headers);
      res.end(body);
    } catch (error) {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  return {
    store,
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return { url: new URL(`http://127.0.0.1:${server.address().port}`) };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
