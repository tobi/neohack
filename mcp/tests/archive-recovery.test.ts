import { expect, test } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  symlinkSync,
  mkdirSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { TestBridge, testDirectory, ROOT } from "./bridge-harness";
import { createRunStore } from "../src/runs";
import { parseRecording, LocalRecording } from "../../client/recording.js";
const text = (root: string, id: string, name: string) =>
  readFileSync(join(root, id, name), "utf8");
const records = (root: string, id: string) =>
  text(root, id, "perceptions.jsonl").trim().split("\n").map(JSON.parse);
const withoutHealth = (r: any) => {
  const { recording, ...receipt } = r;
  return receipt;
};

test("complete checkpoints recover stale counters, missing metadata and a torn index without rewriting history", async () => {
  const root = testDirectory("archive"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const g = await a.newGame();
    const id = g.sessionId;
    await a.call("act", { sessionId: id, action: "wait", requestId: "once" });
    await a.close();
    const data = text(root, id, "perceptions.jsonl"),
      input = text(root, id, "input.log.jsonl");
    const meta = JSON.parse(text(root, id, "meta.json"));
    meta.frameCount = 1;
    meta.revision = 0;
    writeFileSync(join(root, id, "meta.json"), JSON.stringify(meta));
    writeFileSync(join(root, id, "perceptions.index.jsonl"), '{"sequence":0');
    unlinkSync(join(root, id, "run.json"));
    const store = createRunStore(root),
      before = text(root, id, "perceptions.index.jsonl");
    expect((await store.index(id)).length).toBe(2);
    expect((await store.list())[0].turn).toBe(2);
    expect(text(root, id, "perceptions.index.jsonl")).toBe(before); // GETs never repair disk.
    await expect(store.index(id, { strict: true })).rejects.toThrow("index");
    expect(text(root, id, "perceptions.jsonl")).toBe(data);
    const resumed = await b.call("resume", { sessionId: id });
    expect(resumed.error).toBeUndefined();
    expect(resumed.observation.turn).toBe(2);
    expect(resumed.revision).toBe(1);
    expect(text(root, id, "input.log.jsonl")).toBe(input);
    expect(text(root, id, "perceptions.jsonl").startsWith(data)).toBe(true);
    expect(records(root, id).map((f: any) => f.sequence)).toEqual([0, 1, 2]);
    expect((await store.index(id, { strict: true })).length).toBe(3);
  } finally {
    await a.close();
    await b.close();
  }
});

test("torn checkpoint bytes remain untouched: replay/export serve only a validated prefix, and resume sends no input", async () => {
  const root = testDirectory("archive-tail"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const g = await a.newGame(),
      id = g.sessionId;
    await a.close();
    const prefix = text(root, id, "perceptions.jsonl"),
      input = text(root, id, "input.log.jsonl");
    appendFileSync(
      join(root, id, "perceptions.jsonl"),
      '{"format":"neonethack.perception","sequence":1',
    );
    const damaged = text(root, id, "perceptions.jsonl"),
      store = createRunStore(root);
    const index = await (
      await store.handle(new Request(`http://localhost/runs/${id}/index`))
    ).json();
    expect(index.frames.length).toBe(1);
    expect(index.integrity.state).toBe("partial");
    expect(index.integrity.validBytes).toBe(Buffer.byteLength(prefix));
    const exported = await (
      await store.handle(new Request(`http://localhost/runs/${id}/export`))
    ).text();
    const imported = new LocalRecording(parseRecording(exported));
    expect(imported.frames).toEqual(parseRecording(prefix));
    expect(imported.integrity.state).toBe("partial");
    expect(imported.integrity.validBytes).toBe(Buffer.byteLength(prefix));
    expect(
      await (
        await store.handle(
          new Request(`http://localhost/runs/${id}/export?raw=1`),
        )
      ).text(),
    ).toBe(damaged);
    expect((await store.list())[0].integrity.state).toBe("partial");
    expect((await b.call("resume", { sessionId: id })).error.code).toBe(
      "recordingUnavailable",
    );
    expect(text(root, id, "input.log.jsonl")).toBe(input);
    expect(text(root, id, "perceptions.jsonl")).toBe(damaged);
    if (process.platform === "linux")
      expect(
        readFileSync(
          `/proc/${b.proc.pid}/task/${b.proc.pid}/children`,
          "utf8",
        ).trim(),
      ).toBe("");
  } finally {
    await a.close();
    await b.close();
  }
});

test("an unrecorded request is marked as a history gap on resume and cannot execute twice after cache eviction", async () => {
  const root = testDirectory("archive-gap"),
    a = new TestBridge(root),
    b = new TestBridge(root),
    c = new TestBridge(root);
  try {
    const g = await a.newGame(),
      id = g.sessionId;
    const initial = text(root, id, "perceptions.jsonl"),
      idx = text(root, id, "perceptions.index.jsonl");
    const deed = { sessionId: id, action: "wait", requestId: "lost-boundary" };
    const played = await a.call("act", deed);
    await a.close();
    // Model process loss after receipt/inputs, but before checkpoint append.
    writeFileSync(join(root, id, "perceptions.jsonl"), initial);
    writeFileSync(join(root, id, "perceptions.index.jsonl"), idx);
    const meta = JSON.parse(text(root, id, "meta.json"));
    meta.frameCount = 1;
    writeFileSync(join(root, id, "meta.json"), JSON.stringify(meta));
    const back = await b.call("resume", { sessionId: id });
    expect(back.observation).toEqual(played.observation);
    expect(records(root, id)[1].gapBefore).toBe(true);
    expect(await b.call("act", deed)).toEqual(played);
    for (let i = 0; i < 70; i++)
      await b.call("act", {
        sessionId: id,
        action: "inventory",
        requestId: `peek-${i}`,
      });
    await b.close();
    await c.call("resume", { sessionId: id });
    const before = text(root, id, "input.log.jsonl");
    expect((await c.call("act", deed)).error.code).toBe("incompleteRequest");
    expect(text(root, id, "input.log.jsonl")).toBe(before);
    const snap = await createRunStore(root).snapshot(id);
    expect(snap.integrity.gaps).toEqual([1]);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
}, 15000);

test("a malformed frame cannot supply an apparently complete cold receipt", async () => {
  const root = testDirectory("archive-receipt"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const g = await a.newGame(),
      id = g.sessionId,
      deed = { sessionId: id, action: "inventory", requestId: "old" };
    await a.call("act", deed);
    for (let i = 0; i < 70; i++)
      await a.call("act", {
        sessionId: id,
        action: "inventory",
        requestId: `q-${i}`,
      });
    await a.close();
    const lines = text(root, id, "perceptions.jsonl").split("\n");
    lines[1] += "corrupt";
    writeFileSync(join(root, id, "perceptions.jsonl"), lines.join("\n"));
    const before = text(root, id, "input.log.jsonl");
    expect((await b.call("resume", { sessionId: id })).error.code).toBe(
      "recordingUnavailable",
    );
    expect((await b.call("act", deed)).error.code).toBe("incompleteRequest");
    expect(text(root, id, "input.log.jsonl")).toBe(before);
    const store = createRunStore(root);
    expect((await store.index(id)).length).toBe(1);
    expect((await store.snapshot(id)).integrity.state).toBe("corrupt");
    await expect(store.index(id, { strict: true })).rejects.toThrow(
      "incomplete",
    );
  } finally {
    await a.close();
    await b.close();
  }
}, 15000);

let shim: string;
function faultShim() {
  if (shim) return shim;
  shim = join(testDirectory("record-fault"), "fsync.so");
  const compile = Bun.spawnSync([
    "cc",
    "-shared",
    "-fPIC",
    "-o",
    shim,
    `${ROOT}/mcp/tests/recording-fault.c`,
    "-ldl",
  ]);
  if (compile.exitCode) throw Error(compile.stderr.toString());
  return shim;
}
for (const mode of ["data", "index", "meta"])
  test.skipIf(process.platform !== "linux")(
    `real ${mode} fsync failure reports degradation, preserves the deed receipt and recovers without duplicate sequences`,
    async () => {
      const root = testDirectory(`fault-${mode}`),
        control = join(root, "fault");
      const b = new TestBridge(root, {
        LD_PRELOAD: faultShim(),
        NH_TEST_RECORDING_FAILURE: control,
      });
      try {
        const g = await b.newGame(),
          id = g.sessionId;
        writeFileSync(control, mode);
        const deed = { sessionId: id, action: "wait", requestId: "faulted" };
        const acted = await b.call("act", deed);
        expect(acted.observation.turn).toBe(2);
        expect(acted.outcome.status).toBe("completed");
        expect(acted.recording.status).toBe("degraded");
        const retried = await b.call("act", deed);
        expect(withoutHealth(retried)).toEqual(withoutHealth(acted));
        expect(retried.recording.status).toBe("degraded");
        const store = createRunStore(root);
        expect((await store.list())[0].turn).toBe(2);
        unlinkSync(control);
        const input = text(root, id, "input.log.jsonl");
        const resumed = await b.call("resume", { sessionId: id });
        expect(resumed.error).toBeUndefined();
        expect(resumed.recording).toBeUndefined();
        expect(resumed.observation).toEqual(acted.observation);
        expect(text(root, id, "input.log.jsonl")).toBe(input);
        const frames = records(root, id);
        expect(frames.map((f: any) => f.sequence)).toEqual([0, 1, 2]);
        expect(frames.some((f: any) => f.gapBefore)).toBe(false);
        expect((await store.index(id, { strict: true })).length).toBe(3);
      } finally {
        try {
          unlinkSync(control);
        } catch {}
        await b.close();
      }
    },
    15000,
  );

test("large sparse archives are bounded without allocating or exporting their whole body", async () => {
  const root = testDirectory("archive-limit"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  let path: string | undefined, original: string | undefined;
  try {
    const g = await a.newGame(),
      id = g.sessionId;
    await a.close();
    path = join(root, id, "perceptions.jsonl");
    original = readFileSync(path, "utf8");
    const store = createRunStore(root);
    truncateSync(path, 2 * 1024 * 1024 * 1024);
    const limited = await store.snapshot(id);
    expect(limited.rows.length).toBe(1);
    expect(limited.integrity.state).toBe("limited");
    const head = await store.handle(
      new Request(`http://localhost/runs/${id}/export?raw=1`, {
        method: "HEAD",
      }),
    );
    expect(head.headers.get("content-length")).toBe(
      String(2 * 1024 * 1024 * 1024),
    );
    truncateSync(path, 8 * 1024 * 1024 * 1024 + 1);
    expect(
      (await store.handle(new Request(`http://localhost/runs/${id}/index`)))
        .status,
    ).toBe(413);
    const before = text(root, id, "input.log.jsonl");
    expect((await b.call("resume", { sessionId: id })).error.code).toBe(
      "recordingUnavailable",
    );
    expect(text(root, id, "input.log.jsonl")).toBe(before);
  } finally {
    if (path && original) writeFileSync(path, original);
    await a.close();
    await b.close();
  }
});

test("archive and lease symlinks cannot redirect writers or read-only review", async () => {
  const root = testDirectory("archive-links"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const g = await a.newGame(),
      id = g.sessionId;
    await a.close();
    const original = text(root, id, "perceptions.jsonl"),
      outside = join(root, "outside");
    writeFileSync(outside, original);
    unlinkSync(join(root, id, "perceptions.jsonl"));
    symlinkSync(outside, join(root, id, "perceptions.jsonl"));
    expect((await b.call("resume", { sessionId: id })).error.code).toBe(
      "recordingUnavailable",
    );
    expect(readFileSync(outside, "utf8")).toBe(original);
    expect(
      (
        await createRunStore(root).handle(
          new Request(`http://localhost/runs/${id}/export?raw=1`),
        )
      ).status,
    ).toBe(404);
    mkdirSync(join(root, "alias"));
    symlinkSync(outside, join(root, "alias", ".lease"));
    expect(
      (await b.call("resume", { sessionId: "alias" })).error,
    ).toBeDefined();
    expect(readFileSync(outside, "utf8")).toBe(original);
  } finally {
    await a.close();
    await b.close();
  }
});
