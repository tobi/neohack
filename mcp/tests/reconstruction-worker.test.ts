import { afterEach, expect, test } from "bun:test";
import { cp, readFile, writeFile, chmod, rm, readlink } from "node:fs/promises";
import { TestBridge, testDirectory, ROOT } from "./bridge-harness";
import { createReconstructor } from "../src/reconstruct";
const bridges: TestBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close().catch(() => {});
});
async function fixture() {
  const root = testDirectory("worker"),
    b = new TestBridge(root);
  bridges.push(b);
  const g = await b.newGame();
  await b.call("act", {
    sessionId: g.sessionId,
    action: "move",
    direction: "south",
  });
  await b.call("end_session", { sessionId: g.sessionId });
  await cp(`${root}/${g.sessionId}`, `${root}/legacy`, { recursive: true });
  for (const f of ["run.json", "perceptions.jsonl", "perceptions.index.jsonl"])
    await rm(`${root}/legacy/${f}`);
  return { root, b };
}
const options = () => ({
  bridge: process.env.NHXCLI ?? `${ROOT}/mcp/bin/nhxcli`,
});
const hasSandbox =
  process.platform === "linux" &&
  !!Bun.which("bwrap") &&
  !!Bun.which("prlimit");

test.skipIf(!hasSandbox)(
  "sandbox worker publishes only a complete read-only derived archive",
  async () => {
    const { root, b } = await fixture(),
      manager = createReconstructor(root, options());
    const input = await readFile(`${root}/legacy/input.log.jsonl`, "utf8");
    const started = await manager.start("legacy");
    expect(started.status).toBe(202);
    const job = await manager.wait((started.body as any).job.id);
    expect(job?.state).toBe("completed");
    expect(job.provenance.verification).toBe("unverified");
    expect(await readFile(`${root}/legacy/input.log.jsonl`, "utf8")).toBe(
      input,
    );
    expect(
      await Bun.file(`${root}/${job.archiveId}/perceptions.jsonl`).exists(),
    ).toBe(true);
    expect(await Bun.file(`${root}/${job.archiveId}/engine`).exists()).toBe(
      false,
    );
    expect(
      (await b.call("resume", { sessionId: job.archiveId })).error.code,
    ).toBe("readOnlyRecording");
  },
  15000,
);

test("management requires confirmation and a permitted origin; missing sandbox never falls back", async () => {
  const { root } = await fixture(),
    manager = createReconstructor(root, {
      ...options(),
      bwrap: "/missing/bubblewrap",
    });
  expect(
    (
      await manager.handle(
        new Request("http://localhost/runs/legacy/reconstruct"),
      )
    ).status,
  ).toBe(405);
  expect(
    (
      await manager.handle(
        new Request("http://localhost/runs/legacy/reconstruct", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://evil",
          },
          body: '{"confirm":true}',
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await manager.handle(
        new Request("http://localhost/runs/legacy/reconstruct", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(400);
  for (const body of [
    '{"confirm":false,"confirm":true}',
    '{"confirm":true,"unexpected":1}',
  ])
    expect(
      (
        await manager.handle(
          new Request("http://localhost/runs/legacy/reconstruct", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        )
      ).status,
    ).toBe(400);
  const start = await manager.start("legacy"),
    job = await manager.wait((start.body as any).job.id);
  expect(job.state).toBe("failed");
  expect(job.error.code).toBe("sandboxUnavailable");
  expect(await Bun.file(`${root}/${job.archiveId}/run.json`).exists()).toBe(
    false,
  );
});

test.skipIf(!hasSandbox)(
  "sandbox denies source writes, hides unrelated files, and isolates networking",
  async () => {
    const { root } = await fixture(),
      secretRoot = testDirectory("outside-secret"),
      secret = `${secretRoot}/secret`;
    await writeFile(secret, "not available to a historical engine");
    const net = await readlink("/proc/self/ns/net");
    const script = `#!/bin/sh\nif echo changed >> /sources/legacy/input.log.jsonl; then echo SOURCE_WRITABLE >&2; else echo SOURCE_READ_ONLY >&2; fi\nif test -d /sources/legacy/playground/save; then echo FUTURE_SAVE_VISIBLE >&2; else echo FUTURE_SAVE_HIDDEN >&2; fi\nif test -e '${secret}'; then echo SECRET_VISIBLE >&2; else echo SECRET_HIDDEN >&2; fi\nif test "$(readlink /proc/self/ns/net)" = '${net}'; then echo NETWORK_SHARED >&2; else echo NETWORK_ISOLATED >&2; fi\nexit 0\n`;
    await writeFile(`${root}/legacy/engine`, script);
    await chmod(`${root}/legacy/engine`, 0o700);
    const input = await readFile(`${root}/legacy/input.log.jsonl`, "utf8");
    const manager = createReconstructor(root, options()),
      start = await manager.start("legacy");
    const job = await manager.wait((start.body as any).job.id);
    expect(job.state).toBe("failed");
    const diagnostic = await readFile(
      `${root}/.reconstruction-jobs/${job.id}/diagnostic.log`,
      "utf8",
    );
    expect(diagnostic).toContain("SOURCE_READ_ONLY");
    expect(diagnostic).toContain("FUTURE_SAVE_HIDDEN");
    expect(diagnostic).toContain("SECRET_HIDDEN");
    expect(diagnostic).toContain("NETWORK_ISOLATED");
    expect(diagnostic).not.toContain("SOURCE_WRITABLE");
    expect(await readFile(`${root}/legacy/input.log.jsonl`, "utf8")).toBe(
      input,
    );
    expect(await Bun.file(`${root}/${job.archiveId}/run.json`).exists()).toBe(
      false,
    );
  },
  15000,
);

test.skipIf(!hasSandbox)(
  "publication refuses symlinks left by an exiting historical engine",
  async () => {
    const { root } = await fixture();
    const emit = (object: any) => `printf '%s\\n' '${JSON.stringify(object)}'`;
    const script =
      [
        "#!/bin/sh",
        "read first",
        "read second",
        emit({ method: "window_create", params: { window: 1, type: 3 } }),
        emit({ method: "cursor", params: { window: 1, x: 2, y: 2 } }),
        emit({ method: "status_update", params: { field: 16, value: "1" } }),
        emit({
          method: "snapshot",
          params: {
            full: true,
            cells: [{ x: 2, y: 2, glyph: 0, ttychar: 64, framecolor: 7 }],
          },
        }),
        emit({ method: "input", id: 1, params: { kind: "ack" } }),
        "read ack",
        emit({ method: "input", id: 2, params: { kind: "poskey" } }),
        "read step",
        emit({ method: "status_update", params: { field: 16, value: "2" } }),
        emit({ method: "input", id: 3, params: { kind: "poskey" } }),
        "cat >/dev/null",
        "rm -f ../perceptions.jsonl",
        "ln -s /etc/passwd ../perceptions.jsonl",
      ].join("\n") + "\n";
    await writeFile(`${root}/legacy/engine`, script);
    await chmod(`${root}/legacy/engine`, 0o700);
    const manager = createReconstructor(root, options()),
      start = await manager.start("legacy");
    const job = await manager.wait((start.body as any).job.id);
    expect(job.state).toBe("failed");
    expect(job.error.message).toContain("non-regular");
    expect(await Bun.file(`${root}/${job.archiveId}/run.json`).exists()).toBe(
      false,
    );
  },
  15000,
);

test.skipIf(!hasSandbox)(
  "a stalled sandbox is terminated and releases its source lease",
  async () => {
    const { root } = await fixture();
    await writeFile(`${root}/legacy/engine`, "#!/bin/sh\ncat >/dev/null\n");
    await chmod(`${root}/legacy/engine`, 0o700);
    const manager = createReconstructor(root, { ...options(), timeoutMs: 300 });
    const start = await manager.start("legacy"),
      job = await manager.wait((start.body as any).job.id);
    expect(job.state).toBe("failed");
    expect(job.error.code).toBe("reconstructionTimeout");
    const lock = Bun.spawn(
      ["flock", "-w", "3", `${root}/legacy/.lease`, "true"],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await lock.exited).toBe(0);
    expect(await Bun.file(`${root}/${job.archiveId}/run.json`).exists()).toBe(
      false,
    );
  },
  15000,
);
