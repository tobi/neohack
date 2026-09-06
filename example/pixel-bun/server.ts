import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Bun serves files only. Worlds and journals belong to the browser's owned
// IndexedDB store. There is deliberately no server-side game route.
export async function startServer(port = Number(process.env.PORT ?? 3333)) {
  const publicRoot = await realpath(resolve(import.meta.dir, "public"));
  const runtimeRoot = await realpath(
    resolve(import.meta.dir, "../../lib/neonethack/dist"),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      };
      if (!["GET", "HEAD"].includes(request.method))
        return new Response("Method not allowed", {
          status: 405,
          headers: { ...headers, Allow: "GET, HEAD" },
        });
      try {
        const path = decodeURIComponent(new URL(request.url).pathname);
        const runtime = path.startsWith("/runtime/");
        const root = runtime ? runtimeRoot : publicRoot;
        let relative = runtime
          ? path.slice(9)
          : path === "/"
            ? "index.html"
            : path === "/dashboard" ? "dashboard.html" : ["/component", "/component/"].includes(path) ? "component/index.html" : path.slice(1);
        if (runtime && relative === 'wasm/current.json') {
          const manifest = await Bun.file(resolve(runtimeRoot,'wasm/manifest.json')).json();
          return Response.json({version:1,buildId:manifest.buildId},{headers});
        }
        const versioned = relative.match(/^wasm\/([a-f0-9]{64})\/(.+)$/);
        if (runtime && versioned) {
          const manifest = await Bun.file(resolve(runtimeRoot,'wasm/manifest.json')).json();
          if (versioned[1] !== manifest.buildId) throw Error('Runtime not installed');
          relative = 'wasm/' + versioned[2];
        }
        if (runtime && !/^(?:wasm|typescript|mcp|protocol)\//.test(relative))
          throw Error("Not a public runtime file");
        const file = await realpath(resolve(root, relative));
        if (!file.startsWith(root + sep) || !(await stat(file)).isFile())
          throw Error("Not a public file");
        const blob = Bun.file(file);
        return new Response(request.method === "HEAD" ? null : blob, {
          headers: {
            ...headers,
            "Content-Type": file.endsWith(".mjs")
              ? "text/javascript"
              : blob.type,
            "Content-Length": String(blob.size),
          },
        });
      } catch {
        return new Response("Not found", { status: 404, headers });
      }
    },
  });
  return server;
}
if (import.meta.main) {
  const server = await startServer();
  console.log(`NEONETHACK READY http://127.0.0.1:${server.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      server.stop(true);
      process.exit(0);
    });
}
