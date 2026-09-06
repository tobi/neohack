import { readFile } from "node:fs/promises";
import { Accounts } from "../src/accounts.ts";
import { vaults } from "../src/vaults.ts";
import { replay } from '../src/replays.ts';
import { board } from "../src/board.ts";
import { configured, Conflict, read } from "../src/storage.ts";
async function dispatch(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("__path");
  if (path) {
    url.pathname = "/api/" + path;
    url.searchParams.delete("__path");
    request = new Request(url, request);
  }
  const pathname = url.pathname;
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!configured())
    return json({ error: "Private Vercel Blob is not configured" }, 503);
  try {
    const publicReplay=pathname.match(/^\/api\/runs\/([\w-]{1,64})\/replay$/);
    if(publicReplay)return await replay(request,publicReplay[1]);
    if (pathname === "/api/health") {
      await read("board/index.json"); // Verify access, not just presence of a token.
      return json({ ok: true, storage: "available", platform: "vercel", webmcp: "browser-mediated" });
    }
    if (pathname === "/api/account" || pathname.startsWith("/api/account/"))
      return await new Accounts().fetch(request);
    if (
      ["/api/stats", "/api/runs", "/api/errors"].includes(pathname) ||
      /^\/api\/runs\/[\w-]+$/.test(pathname)
    )
      return await board(request);
    const vault = pathname.match(/^\/api\/vaults\/([^/]+)(\/adventures)?$/);
    if (vault) return await vaults(request, vault[1], !!vault[2]);
    return json({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof Conflict)
      return json({ error: "Concurrent storage update; retry" }, 409);
    console.error("request_failed", { code: "server" });
    return json({ error: "Storage unavailable" }, 503);
  }
}
// Document navigations get a readable fallback; programmatic clients retain
// their structured error and the original HTTP status.
export async function handler(request: Request) {
  const response = await dispatch(request);
  if (!request.headers.get('accept')?.includes('text/html')) return response;
  const file = response.status >= 500 ? new URL('../public/500.html', import.meta.url)
    : response.status === 400 ? new URL('../public/400.html', import.meta.url)
    : response.status === 404 ? new URL('../public/404.html', import.meta.url) : null;
  if (!file) return response;
  try {
    return new Response(await readFile(file, 'utf8'), {status:response.status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  } catch { return response; }
}
export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as DELETE,
  handler as PATCH,
};
