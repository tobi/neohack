import { test, expect } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  symlinkSync,
  linkSync,
  existsSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bundleFixture } from "./bundle-fixture";
import { startBundleCLI } from "./bundle-cli";
import {
  openBundleReview,
  createBundleReviewHandler,
} from "../src/bundle-review";
import {
  LocalRecording,
  parseRecording,
  RemoteRecording,
} from "../../client/recording.js";
import { ROOT, testDirectory } from "./bridge-harness";
const hash = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const manifest = (dest: string) => join(dest, "manifest.json");
function alter(dest: string, fn: (m: any) => void) {
  const path = manifest(dest),
    m = JSON.parse(readFileSync(path, "utf8"));
  fn(m);
  chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify(m));
}
function tree(root: string): any {
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .map((n) => {
        const p = join(root, n),
          s = lstatSync(p);
        return [
          n,
          s.isDirectory() ? tree(p) : s.isSymbolicLink() ? "symlink" : hash(p),
        ];
      }),
  );
}

test("completed bundle review pages only unchanged public checkpoints, retaining source identity and damage warnings", async () => {
  const f = await bundleFixture(),
    original = tree(f.root),
    before = tree(f.dest),
    b = await openBundleReview(f.dest);
  try {
    expect(b.id).toBe(f.id);
    expect(b.integrity.state).toBe("partial");
    expect(b.integrity.notice).toContain("private evidence");
    const list = await b.store.list();
    expect(list[0].sessionId).toBe(f.id);
    expect(list[0].frames).toBe(2);
    const page = await (
      await b.store.handle(
        new Request(`http://localhost/runs/${f.id}/frames?from=1&limit=1`),
      )
    ).json();
    expect(page.frames).toHaveLength(1);
    expect(page.frames[0].response.sessionId).toBe(f.id);
    expect(page.frames[0].response.observation.turn).toBe(2);
    expect(page.integrity.notice).toContain("Salvaged bundle");
    const exported = await (
        await b.store.handle(
          new Request(`http://localhost/runs/${f.id}/export`),
        )
      ).text(),
      recording = new LocalRecording(parseRecording(exported));
    expect(recording.integrity.state).toBe("partial");
    expect(recording.frames).toHaveLength(2);
    expect(recording.integrity.notice).toContain("not authenticity");
    expect(
      (
        await b.store.handle(
          new Request(`http://localhost/runs/${f.id}/export?raw=1`),
        )
      ).status,
    ).toBe(403);
    expect(
      (await b.store.handle(new Request("http://localhost/runs/another/index")))
        .status,
    ).toBe(404);
    await expect(b.store.index(f.id, { strict: true })).rejects.toThrow(
      "not a reconstruction",
    );
    expect(tree(f.dest)).toEqual(before);
    expect(tree(f.root)).toEqual(original);
  } finally {
    await b.close();
  }
});

test("private evidence and pinned executables are neither read nor served", async () => {
  const f = await bundleFixture(),
    marker = join(testDirectory("bundle-secret"), "private");
  writeFileSync(marker, "PRIVATE_SENTINEL");
  for (const name of [
    "engine",
    "meta.json",
    "input.log.jsonl",
    "requests.seen.jsonl",
  ]) {
    unlinkSync(join(f.dest, "evidence", name));
    symlinkSync(marker, join(f.dest, "evidence", name));
  }
  // Verification is deliberately public-checkpoint only, not a claim that the
  // rest of the bundle is intact. These private paths must never be followed.
  const b = await openBundleReview(f.dest);
  try {
    const handle = await createBundleReviewHandler(b, join(ROOT, "client"));
    for (const path of [
      "/manifest.json",
      "/evidence/meta.json",
      "/evidence/engine",
      "/input.log.jsonl",
      "/mcp",
      "/reconstructions/x",
      "/runs/" + f.id + "/reconstruct",
    ]) {
      const r = await handle(new Request("http://localhost" + path));
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("PRIVATE_SENTINEL");
    }
    expect(
      (
        await handle(
          new Request("http://localhost/mcp", {
            method: "POST",
            body: '{"tool":"new_game"}',
          }),
        )
      ).status,
    ).toBe(405);
    expect((await handle(new Request("http://localhost/runs"))).status).toBe(
      200,
    );
  } finally {
    await b.close();
  }
});

for (const mode of [
  "failed",
  "missing",
  "duplicate",
  "traversal",
  "identity",
  "watermark",
  "hash",
  "public-symlink",
  "public-hardlink",
  "directory-symlink",
])
  test(`bundle viewer rejects ${mode} evidence/manifest without repair`, async () => {
    const f = await bundleFixture(),
      path = join(f.dest, "evidence/perceptions.jsonl");
    if (mode === "failed") writeFileSync(join(f.dest, "FAILED.json"), "{}");
    if (mode === "missing") unlinkSync(manifest(f.dest));
    if (mode === "duplicate") {
      const m = readFileSync(manifest(f.dest), "utf8");
      chmodSync(manifest(f.dest), 0o600);
      writeFileSync(
        manifest(f.dest),
        m.replace(
          '"state": "complete"',
          '"state":"complete","state":"complete"',
        ),
      );
    }
    if (mode === "traversal")
      alter(f.dest, (m) => (m.entries[0].path = "../private"));
    if (mode === "identity")
      alter(f.dest, (m) => (m.sourceSessionId = "not-the-source"));
    if (mode === "watermark") alter(f.dest, (m) => m.integrity.validBytes--);
    if (mode === "hash") {
      chmodSync(path, 0o600);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace("Lifecycle", "OtherHero"),
      );
    }
    if (mode === "public-symlink") {
      const outside = join(testDirectory("bundle-data"), "data");
      writeFileSync(outside, readFileSync(path));
      unlinkSync(path);
      symlinkSync(outside, path);
    }
    if (mode === "public-hardlink") linkSync(path, join(f.dest, "alias"));
    if (mode === "directory-symlink") {
      const fs = await import("node:fs");
      fs.renameSync(join(f.dest, "evidence"), join(f.dest, "moved"));
      symlinkSync(join(f.dest, "moved"), join(f.dest, "evidence"));
    }
    const sourceHash = hash(f.path);
    await expect(openBundleReview(f.dest)).rejects.toThrow();
    expect(hash(f.path)).toBe(sourceHash);
  });

test("post-open mutation fails closed, including an export that has not been consumed", async () => {
  const f = await bundleFixture(),
    b = await openBundleReview(f.dest);
  try {
    const r = await b.store.handle(
      new Request(`http://localhost/runs/${f.id}/export`),
    );
    const path = join(f.dest, "evidence/perceptions.jsonl");
    chmodSync(path, 0o600);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("Lifecycle", "OtherHero"),
    );
    await expect(r.text()).rejects.toThrow();
    expect(
      (
        await b.store.handle(
          new Request(`http://localhost/runs/${f.id}/frames`),
        )
      ).status,
    ).toBe(409);
  } finally {
    await b.close();
  }
});

test("cancelled exports release their public file handles before any frame is consumed", async () => {
  const f = await bundleFixture(),
    b = await openBundleReview(f.dest),
    path = join(f.dest, "evidence/perceptions.jsonl");
  const count = () =>
    readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync("/proc/self/fd/" + fd) === path;
      } catch {
        return false;
      }
    }).length;
  try {
    const before = count();
    for (let i = 0; i < 12; i++) {
      const response = await b.store.handle(
        new Request(`http://localhost/runs/${f.id}/export`),
      );
      await response.body!.cancel();
    }
    const end = performance.now() + 1000;
    while (count() > before && performance.now() < end)
      await new Promise((r) => setTimeout(r, 10));
    expect(count()).toBe(before);
  } finally {
    await b.close();
  }
});

test("host/origin policy, methods, paths and range budgets remain strict on the dedicated viewer", async () => {
  const f = await bundleFixture(),
    b = await openBundleReview(f.dest);
  try {
    const handle = await createBundleReviewHandler(b, join(ROOT, "client"));
    expect(
      (await handle(new Request("http://hostile.example/runs"))).status,
    ).toBe(403);
    expect(
      (
        await handle(
          new Request("http://localhost/runs", {
            headers: { origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handle(
          new Request("http://localhost/runs", {
            headers: { "sec-fetch-site": "cross-site" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await handle(new Request("http://localhost/runs", { method: "DELETE" })))
        .status,
    ).toBe(405);
    for (const query of ["from=-1", "from=1.5", "limit=101", "limit=0"])
      expect(
        (
          await handle(
            new Request(`http://localhost/runs/${f.id}/frames?${query}`),
          )
        ).status,
      ).toBe(400);
    const html = await handle(new Request("http://localhost/play"));
    expect(await html.text()).toContain("<explorer-view read-only>");
    expect(html.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(
      await (
        await handle(
          new Request(`http://localhost/runs/${f.id}/frames`, {
            method: "HEAD",
          }),
        )
      ).text(),
    ).toBe("");
  } finally {
    await b.close();
  }
});

test("dedicated CLI has no engine child or executable route, even with trapped engine configuration", async () => {
  const f = await bundleFixture(),
    marker = join(testDirectory("bundle-execution"), "ran"),
    trap = join(testDirectory("bundle-trap"), "engine");
  writeFileSync(trap, `#!/bin/sh\necho executed > '${marker}'\n`);
  chmodSync(trap, 0o700);
  const pin = join(f.dest, "evidence/engine");
  chmodSync(pin, 0o700);
  writeFileSync(pin, readFileSync(trap));
  const server = await startBundleCLI(f.dest, {
    NHXCLI: trap,
    ENGINE_CMD: trap,
  });
  try {
    const base = new URL(server.url).origin;
    expect(server.ready.readOnly).toBe(true);
    expect(
      (
        await fetch(base + "/mcp", {
          method: "POST",
          body: '{"tool":"new_game"}',
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await fetch(base + `/runs/${f.id}/reconstruct`, {
          method: "POST",
          body: '{"confirm":true}',
        })
      ).status,
    ).toBe(405);
    expect((await fetch(base + "/evidence/engine")).status).toBe(404);
    expect((await fetch(base + "/runs")).status).toBe(200);
    expect(
      readFileSync(
        `/proc/${server.proc.pid}/task/${server.proc.pid}/children`,
        "utf8",
      ).trim(),
    ).toBe("");
    expect(existsSync(marker)).toBe(false);
  } finally {
    await server.stop();
  }
}, 20000);

test("zero valid frames stay evidence-only, never a fabricated playable recording", async () => {
  const f = await bundleFixture({ empty: true }),
    b = await openBundleReview(f.dest);
  try {
    expect((await b.store.list())[0].replayReady).toBe(false);
    expect(await b.store.index(f.id)).toHaveLength(0);
    expect(
      (
        await (
          await b.store.handle(
            new Request(`http://localhost/runs/${f.id}/frames`),
          )
        ).json()
      ).frames,
    ).toHaveLength(0);
  } finally {
    await b.close();
  }
});

test("a bundle above the browser import ceiling is paged with unchanged provenance and bounded transport cache", async () => {
  const f = await bundleFixture({ large: true });
  expect(f.result.integrity.validBytes).toBeGreaterThan(128 * 1024 * 1024);
  const b = await openBundleReview(f.dest);
  try {
    let max = 0;
    const recording = new RemoteRecording(f.id, async (path: string) => {
      const r = await b.store.handle(new Request("http://localhost" + path));
      if (path.includes("/frames"))
        max = Math.max(
          max,
          Number(r.headers.get("content-length")) ||
            Buffer.byteLength(await r.clone().text()),
        );
      return r;
    });
    await recording.open();
    expect(recording.index).toHaveLength(f.frames);
    for (const sequence of [f.frames - 1, 0, 30, 60, 90, 120, 150, 180, 210]) {
      const frame = await recording.frame(sequence);
      expect(frame.sequence).toBe(sequence);
      expect(frame.response.provenance.verification).toBe("unverified");
    }
    expect(recording.pages.size).toBeLessThanOrEqual(6);
    expect(max).toBeLessThan(32 * 1024 * 1024);
    expect(recording.integrity.notice).toContain("Salvaged bundle");
  } finally {
    await b.close();
  }
}, 30000);

test("oversized transport pages shrink without skipping large valid frames", async () => {
  const f = await bundleFixture({ frameBytes: 6 * 1024 * 1024 }),
    b = await openBundleReview(f.dest);
  try {
    let rejected = 0;
    const recording = new RemoteRecording(f.id, async (path: string) => {
      const r = await b.store.handle(new Request("http://localhost" + path));
      if (r.status === 413) rejected++;
      return r;
    });
    await recording.open();
    expect((await recording.frame(6)).sequence).toBe(6);
    expect(rejected).toBeGreaterThan(0);
    expect(recording.pageSize).toBeLessThan(20);
    expect((await recording.frame(0)).sequence).toBe(0);
  } finally {
    await b.close();
  }
}, 30000);
