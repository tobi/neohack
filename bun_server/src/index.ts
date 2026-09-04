// neonethack bun front: static client/site + the world API at /mcp.
// The play page and MCP agents share one world-set in this process
// (mcp/src/server); the old raw WS engine bridge is gone.
import { serve } from "bun";
import { handleMcp } from "../../mcp/src/http";
import { runStore } from "../../mcp/src/runs";
import { reconstructor } from "../../mcp/src/reconstruct";
import { hostAllowed } from "../../mcp/src/origin";
import { resolve } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const CLIENT_DIR = process.env.CLIENT_DIR ?? resolve(import.meta.dir, "../../client");
const SITE_DIR = process.env.SITE_DIR ?? resolve(import.meta.dir, "../../site");

const server = serve({
  port: PORT,
  hostname: process.env.HOST ?? "127.0.0.1",
  maxRequestBodySize: 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    if (!hostAllowed(req)) return new Response("Host is not permitted", {status:403});
    // The world API (MCP Streamable HTTP): POST/GET/DELETE /mcp.
    if (url.pathname === "/mcp") return handleMcp(req);
    if (url.pathname.startsWith("/reconstructions/") || /^\/runs\/[A-Za-z0-9_-]+\/reconstruct$/.test(url.pathname)) return reconstructor.handle(req);
    if (url.pathname === "/runs" || url.pathname.startsWith("/runs/")) return runStore.handle(req);
    if (url.pathname === "/api-docs") {
      return new Response(renderDocsPage(await Bun.file(`${CLIENT_DIR}/API.md`).text()), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // Site frontpage (about), playable client, and their assets.
    // / -> site about page; /play -> client app; /site/* -> site files.
    let dir = CLIENT_DIR;
    let path = url.pathname;
    if (path === "/") {
      dir = SITE_DIR;
      path = "/index.html";
    } else if (path === "/play") {
      path = "/index.html";
    } else if (path === "/site" || path === "/site/") {
      dir = SITE_DIR;
      path = "/index.html";
    } else if (path.startsWith("/site/")) {
      dir = SITE_DIR;
      path = path.slice("/site".length);
    }
    if (path.includes("..")) return new Response("not found", { status: 404 });
    const file = Bun.file(`${dir}${path}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "content-type": contentType(path) },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

// Minimal Markdown renderer (headings, tables, fences, lists, inline
// code/bold/links) — just enough for the API doc, no dependencies.
function renderDocsPage(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0, inFence = false, fenceLang = "", fenceBuf: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const isTableRow = (l: string) => /^\|.*\|\s*$/.test(l);
  const isDelimRow = (l: string) => /^\|[\s:\-|]+\|\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceLang = line.slice(3).trim();
        fenceBuf = [];
      } else {
        inFence = false;
        out.push(
          `<pre><code class="lang-${esc(fenceLang)}">${esc(fenceBuf.join("\n"))}</code></pre>`,
        );
      }
      i++;
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      closeList();
      const cells = (l: string) => l.trim().slice(1, -1).split("|").map((c) => inline(c.trim()));
      out.push("<table><thead><tr>" + cells(line).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        out.push("<tr>" + cells(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>");
        i++;
      }
      out.push("</tbody></table>");
      continue;
    }
    const li = /^-\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      i++;
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  return `<!doctype html><html><head><meta charset="utf-8">
<title>neonethack API docs</title>
<style>
body{background:#14100b;color:#d8cdb8;font:14px/1.55 monospace;max-width:900px;margin:0 auto;padding:24px}
h1,h2,h3,h4{color:#e8b34b} a{color:#7fb4d8} code{background:#241d12;padding:1px 5px;border-radius:3px;color:#f0d9a8}
pre{background:#0d0a06;padding:12px;border:1px solid #4a3a20;border-radius:6px;overflow:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;margin:12px 0} th,td{border:1px solid #4a3a20;padding:4px 10px;text-align:left}
th{color:#e8b34b} ul{padding-left:22px} li{margin:3px 0}
</style></head><body>${out.join("\n")}</body></html>`;
}

console.log(`neonethack bun front on http://localhost:${server.port} (+ /mcp world API)`);
