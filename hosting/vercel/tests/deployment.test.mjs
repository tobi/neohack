import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { getTransformedRoutes } from "@vercel/routing-utils";
import { createTestHarness } from "./server.mjs";
import { handler } from "../api/index.ts";
import { storageContext } from "../src/storage.ts";
const config = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
);

test("Vercel compiled routes serve every entry page and nested API without a SPA catch-all", async (t) => {
  const transformed = getTransformedRoutes(config);
  assert.equal(transformed.error, null);
  const routes = transformed.routes;
  const server = createTestHarness();
  t.after(() => server.close());
  const { url } = await server.listen();
  for (const [path, marker] of [
    ["/", "pixel-nethack"],
    ["/dashboard", "dashboard"],
    ["/component", "neohack-world"],
    ["/bots", "workshop"],
    ["/login", "neohack"],
  ]) {
    const response = await fetch(new URL(path, url));
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).toLowerCase().includes(marker), path);
    if (path !== "/") {
      const rewrite = routes.find(
        (r) => r.dest && new RegExp(r.src).test(path),
      );
      assert.ok(rewrite, path);
      await stat(new URL("../public" + rewrite.dest, import.meta.url));
    }
  }
  for (const path of [
    "/api/health",
    "/api/account/runs",
    "/api/vaults/" + crypto.randomUUID(),
  ]) {
    const rewrite = routes.find((r) => r.dest && new RegExp(r.src).test(path));
    assert.ok(rewrite);
    const dest = path.replace(new RegExp(rewrite.src), rewrite.dest);
    const response = await storageContext.run(server.store, () =>
      handler(new Request(new URL(dest, url))),
    );
    assert.equal(
      response.status,
      path.includes("health") ? 200 : path.includes("account") ? 401 : 404,
    );
  }
  assert.equal((await fetch(new URL("/missing-asset.js", url))).status, 404);
  const sandbox = await fetch(new URL("/bots/sandbox.html", url));
  assert.match(
    sandbox.headers.get("content-security-policy"),
    /connect-src 'none'/,
  );
  const wasm = new URL("../public/runtime/wasm/current.json", import.meta.url);
  const current = JSON.parse(await readFile(wasm, "utf8"));
  const response = await fetch(
    new URL(`/runtime/wasm/${current.buildId}/manifest.json`, url),
  );
  assert.match(response.headers.get("cache-control"), /immutable/);
  assert.match(
    (await fetch(new URL("/runtime/wasm/current.json", url))).headers.get(
      "cache-control",
    ),
    /no-cache/,
  );
});
