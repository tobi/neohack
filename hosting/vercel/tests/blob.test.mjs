import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { storage, Conflict } from "../src/storage.ts";
import { publicReplayStorage } from "../src/public-replay-store.ts";
const require = createRequire(import.meta.url);
const blobRequire = createRequire(require.resolve("@vercel/blob"));
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } =
  blobRequire("undici");

test("real Blob SDK bypasses cached reads and sends create-only / matching-ETag writes", async (t) => {
  const original = process.env.BLOB_READ_WRITE_TOKEN;
  const originalPublic = process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN;
  const originalOrigin = process.env.PUBLIC_REPLAY_ORIGIN;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_fixture_unused";
  process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_fixture_unused";
  process.env.PUBLIC_REPLAY_ORIGIN = "https://fixture.public.blob.vercel-storage.com";
  const agent = new MockAgent(),
    previous = getGlobalDispatcher();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  t.after(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
    if (original === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = original;
    if (originalPublic === undefined) delete process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN;
    else process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN = originalPublic;
    if (originalOrigin === undefined) delete process.env.PUBLIC_REPLAY_ORIGIN;
    else process.env.PUBLIC_REPLAY_ORIGIN = originalOrigin;
  });
  const reads = agent.get("https://fixture.private.blob.vercel-storage.com");
  reads
    .intercept({ method: "GET", path: "/doc.json?cache=0" })
    .reply(200, gzipSync(Buffer.from('{"count":1}')), {
      headers: { etag: '"one"' },
    });
  assert.deepEqual(await storage().read("doc.json"), {
    value: { count: 1 },
    etag: '"one"',
  });
  const writes = agent.get("https://vercel.com");
  const reply = {
    url: "https://fixture.private.blob.vercel-storage.com/doc.json",
    pathname: "doc.json",
    downloadUrl:
      "https://fixture.private.blob.vercel-storage.com/doc.json?download=1",
    contentType: "application/gzip",
    contentDisposition: "attachment",
    etag: '"two"',
  };
  writes
    .intercept({
      method: "PUT",
      path: "/api/blob/?pathname=doc.json",
      headers: (headers) =>
        headers["x-allow-overwrite"] === "0" && !headers["x-if-match"],
    })
    .reply(200, reply);
  await storage().write("doc.json", { count: 1 });
  writes
    .intercept({
      method: "PUT",
      path: "/api/blob/?pathname=doc.json",
      headers: (headers) =>
        headers["x-allow-overwrite"] === "1" &&
        headers["x-if-match"] === '"one"',
    })
    .reply(200, reply);
  await storage().write("doc.json", { count: 2 }, '"one"');
  writes
    .intercept({ method: "PUT", path: "/api/blob/?pathname=doc.json" })
    .reply(412, { error: { code: "precondition_failed", message: "changed" } });
  await assert.rejects(
    storage().write("doc.json", { count: 3 }, '"one"'),
    Conflict,
  );
  // No public CDN interceptor exists: CAS metadata must use the management API.
  writes.intercept({ method: "GET", path: "/api/blob?url=replays%2Frun%2Fmanifest.json" })
    .reply(200, { ...reply, etag: '"current-public"', uploadedAt: new Date().toISOString() });
  assert.deepEqual(await publicReplayStorage().head("replays/run/manifest.json"), {
    etag: '"current-public"',
  });
  agent.assertNoPendingInterceptors();
});
