import { Accounts } from "../src/accounts.ts";
import { vaults } from "../src/vaults.ts";
import { board } from "../src/board.ts";
import { configured, Conflict } from "../src/storage.ts";
export async function handler(request: Request) {
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
    if (pathname === "/api/health")
      return json({ ok: true, platform: "vercel", webmcp: "browser-mediated" });
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
    await board(
      new Request(new URL("/api/errors", url), {
        method: "POST",
        body: JSON.stringify({ code: "server" }),
      }),
    ).catch(() => {});
    return json({ error: "Storage unavailable" }, 503);
  }
}
export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as DELETE,
  handler as PATCH,
};
