import { expect, test } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  existsSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import { ROOT, TestBridge, testDirectory } from "./bridge-harness";
const text = (root: string, id: string, file: string) =>
  readFileSync(join(root, id, file), "utf8");
const noChild = (b: TestBridge) => {
  if (process.platform === "linux")
    expect(
      readFileSync(
        `/proc/${b.proc.pid}/task/${b.proc.pid}/children`,
        "utf8",
      ).trim(),
    ).toBe("");
};
async function seed(root: string) {
  const b = new TestBridge(root);
  try {
    const g = await b.newGame();
    await b.call("act", {
      sessionId: g.sessionId,
      action: "pray",
      requestId: "prayer",
    });
    return g.sessionId;
  } finally {
    await b.close();
  }
}

for (const mode of [
  "torn",
  "duplicate",
  "counter",
  "command",
  "receipt",
  "missing-field",
  "symlink",
  "missing",
])
  test(`invalid ${mode} semantic metadata fails closed without replacing evidence`, async () => {
    const root = testDirectory("meta-integrity"),
      id = await seed(root),
      path = join(root, id, "meta.json");
    const original = text(root, id, "meta.json"),
      meta = JSON.parse(original);
    if (mode === "torn") writeFileSync(path, original.slice(0, -20));
    if (mode === "duplicate")
      writeFileSync(
        path,
        original.replace('"revision":', '"revision":0,"revision":'),
      );
    if (mode === "counter") {
      meta.nextDecision = -1;
      writeFileSync(path, JSON.stringify(meta));
    }
    if (mode === "command") {
      meta.operation.cmdkey = 33;
      writeFileSync(path, JSON.stringify(meta));
    }
    if (mode === "receipt") {
      meta.requests[0].result.sessionId = "another-world";
      writeFileSync(path, JSON.stringify(meta));
    }
    if (mode === "missing-field") {
      delete meta.operation.keypos;
      writeFileSync(path, JSON.stringify(meta));
    }
    if (mode === "symlink") {
      writeFileSync(join(root, "outside-meta"), original);
      unlinkSync(path);
      symlinkSync(join(root, "outside-meta"), path);
    }
    if (mode === "missing") unlinkSync(path);
    const before = existsSync(path) ? readFileSync(path, "utf8") : null,
      inputs = text(root, id, "input.log.jsonl"),
      frames = text(root, id, "perceptions.jsonl");
    const b = new TestBridge(root);
    try {
      const r = await b.call("resume", { sessionId: id });
      expect(r.error.code).toBe("metadataUnavailable");
      noChild(b);
      expect(text(root, id, "input.log.jsonl")).toBe(inputs);
      expect(text(root, id, "perceptions.jsonl")).toBe(frames);
      expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(before);
      expect(
        (await b.call("new_game", { sessionId: id, seed: 1 })).error,
      ).toBeDefined();
      expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(before);
    } finally {
      await b.close();
    }
  });

for (const mode of [
  "torn",
  "shortened",
  "trailing",
  "duplicate",
  "late-init",
  "seed",
  "shape",
  "symlink",
])
  test(`invalid ${mode} input history is never replayed or repaired in place`, async () => {
    const root = testDirectory("input-integrity"),
      id = await seed(root),
      path = join(root, id, "input.log.jsonl");
    let input = text(root, id, "input.log.jsonl"),
      lines = input.trim().split("\n");
    if (mode === "torn") input = input.slice(0, -1);
    if (mode === "shortened") {
      lines.pop();
      input = lines.join("\n") + "\n";
    }
    if (mode === "trailing") input += "garbage\n";
    if (mode === "duplicate") input = input.replace('"id":1', '"id":1,"id":1');
    if (mode === "late-init") input += lines[0] + "\n";
    if (mode === "seed") {
      const init = JSON.parse(lines[1]);
      delete init.params.seed;
      lines[1] = JSON.stringify(init);
      input = lines.join("\n") + "\n";
    }
    if (mode === "shape") {
      const reply = JSON.parse(lines.at(-1)!);
      reply.result = { answer: 42 };
      lines[lines.length - 1] = JSON.stringify(reply);
      input = lines.join("\n") + "\n";
    }
    writeFileSync(path, input);
    if (mode === "symlink") {
      writeFileSync(join(root, "outside-input"), input);
      unlinkSync(path);
      symlinkSync(join(root, "outside-input"), path);
    }
    const meta = text(root, id, "meta.json"),
      frames = text(root, id, "perceptions.jsonl"),
      b = new TestBridge(root);
    try {
      expect((await b.call("resume", { sessionId: id })).error.code).toBe(
        "inputHistoryError",
      );
      noChild(b);
      expect(text(root, id, "input.log.jsonl")).toBe(input);
      expect(text(root, id, "meta.json")).toBe(meta);
      expect(text(root, id, "perceptions.jsonl")).toBe(frames);
    } finally {
      await b.close();
    }
  });

for (const mode of ["wrong-id", "default-answer"])
  test(`a ${mode} at an actual engine prompt aborts instead of guessing`, async () => {
    const root = testDirectory("prompt-integrity"),
      a = new TestBridge(root);
    let id: string;
    try {
      const g = await a.newGame();
      id = g.sessionId;
      const p = await a.call("act", { sessionId: id, action: "pray" });
      await a.call("act", {
        sessionId: id,
        replyTo: p.decision.id,
        confirm: false,
      });
    } finally {
      await a.close();
    }
    const lines = text(root, id!, "input.log.jsonl").trim().split("\n"),
      reply = JSON.parse(lines.at(-1)!);
    if (mode === "wrong-id") reply.id += 100;
    else reply.result = {};
    lines[lines.length - 1] = JSON.stringify(reply);
    writeFileSync(join(root, id!, "input.log.jsonl"), lines.join("\n") + "\n");
    const input = text(root, id!, "input.log.jsonl"),
      meta = text(root, id!, "meta.json"),
      frames = text(root, id!, "perceptions.jsonl");
    // Adjust only the modeled byte watermark: this test targets runtime prompt
    // matching, not the already-tested detection of a shortened file.
    const checkpoint = JSON.parse(meta);
    checkpoint.inputBytes = Buffer.byteLength(input);
    writeFileSync(join(root, id!, "meta.json"), JSON.stringify(checkpoint));
    const b = new TestBridge(root);
    try {
      expect((await b.call("resume", { sessionId: id! })).error.code).toBe(
        "replayMismatch",
      );
      noChild(b);
      expect(text(root, id!, "input.log.jsonl")).toBe(input);
      expect(text(root, id!, "perceptions.jsonl")).toBe(frames);
      expect((await b.call("get_state", { sessionId: id! })).error.code).toBe(
        "noGame",
      );
    } finally {
      await b.close();
    }
  });

test("pending context mismatch is explicit uncertainty, not a rebound confirmation", async () => {
  const root = testDirectory("prompt-fingerprint"),
    id = await seed(root),
    path = join(root, id, "meta.json"),
    meta = JSON.parse(text(root, id, "meta.json"));
  meta.operation.promptSignature = "fnv1a64:0000000000000000";
  writeFileSync(path, JSON.stringify(meta));
  const before = text(root, id, "input.log.jsonl"),
    b = new TestBridge(root);
  try {
    const r = await b.call("resume", { sessionId: id });
    expect(r.error.code).toBe("recoveryRequired");
    expect(r.outcome.status).toBe("unknown");
    expect(r.decision).toBeNull();
    expect(
      (await b.call("act", { sessionId: id, action: "wait" })).error.code,
    ).toBe("recoveryRequired");
    expect(text(root, id, "input.log.jsonl")).toBe(before);
  } finally {
    await b.close();
  }
});

test("an unfinished semantic checkpoint is never silently promoted on resume", async () => {
  const root = testDirectory("unfinished-boundary"),
    id = await seed(root),
    path = join(root, id, "meta.json"),
    meta = JSON.parse(text(root, id, "meta.json"));
  meta.boundaryComplete = false;
  writeFileSync(path, JSON.stringify(meta));
  const b = new TestBridge(root),
    before = text(root, id, "input.log.jsonl");
  try {
    const r = await b.call("resume", { sessionId: id });
    expect(r.error.code).toBe("recoveryRequired");
    expect(r.decision).toBeNull();
    expect(text(root, id, "input.log.jsonl")).toBe(before);
    expect(JSON.parse(text(root, id, "meta.json")).boundaryComplete).toBe(
      false,
    );
  } finally {
    await b.close();
  }
});

test.skipIf(process.platform !== "linux")(
  "a bridge crash after journaling input exposes recovery-required state, not a guessed continuation",
  async () => {
    const root = testDirectory("boundary-crash"),
      a = new TestBridge(root),
      b = new TestBridge(root);
    let engine = 0;
    try {
      const g = await a.newGame(),
        id = g.sessionId,
        path = join(root, id, "input.log.jsonl"),
        before = readFileSync(path, "utf8");
      const children = readFileSync(
        `/proc/${a.proc.pid}/task/${a.proc.pid}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(children).toHaveLength(1);
      engine = children[0];
      expect(readFileSync(`/proc/${engine}/cmdline`, "utf8")).toContain(root);
      process.kill(engine, "SIGSTOP");
      let watcher: ReturnType<typeof watch>,
        timer: ReturnType<typeof setTimeout>;
      const changed = new Promise<void>((resolve, reject) => {
        watcher = watch(path, () => {
          const now = readFileSync(path, "utf8");
          if (now.length > before.length && now.endsWith("\n")) resolve();
        });
        timer = setTimeout(
          () => reject(Error("Input journal did not advance")),
          5000,
        );
      });
      const action = a.call("act", {
        sessionId: id,
        action: "wait",
        requestId: "crashed",
      });
      action.catch(() => {});
      try {
        await changed;
      } finally {
        watcher!.close();
        clearTimeout(timer!);
      }
      await a.close(true);
      await action.catch(() => {});
      process.kill(engine, "SIGKILL");
      engine = 0;
      const input = readFileSync(path, "utf8");
      let resumed: any;
      const end = performance.now() + 3000;
      do {
        resumed = await b.call("resume", { sessionId: id });
        if (resumed.error?.code !== "sessionBusy") break;
        if (performance.now() > end) throw Error("Engine lease did not retire");
        await new Promise((r) => setTimeout(r, 10));
      } while (true);
      expect(resumed.error.code).toBe("recoveryRequired");
      expect(resumed.decision).toBeNull();
      expect(
        (
          await b.call("act", {
            sessionId: id,
            action: "wait",
            requestId: "new",
          })
        ).error.code,
      ).toBe("recoveryRequired");
      expect(readFileSync(path, "utf8")).toBe(input);
    } finally {
      if (engine) {
        try {
          process.kill(engine, "SIGKILL");
        } catch {}
      }
      await a.close();
      await b.close();
    }
  },
  15000,
);

let shim: string;
function faultShim() {
  if (shim) return shim;
  shim = join(testDirectory("private-fault"), "fsync.so");
  const r = Bun.spawnSync([
    "cc",
    "-shared",
    "-fPIC",
    "-o",
    shim,
    `${ROOT}/mcp/tests/recording-fault.c`,
    "-ldl",
  ]);
  if (r.exitCode) throw Error(r.stderr.toString());
  return shim;
}
for (const mode of ["sidecar", "input"])
  test.skipIf(process.platform !== "linux")(
    `a real ${mode} fsync failure is visible and sends no engine answer`,
    async () => {
      const root = testDirectory(`private-${mode}`),
        control = join(root, "fault"),
        owner = join(root, "owner"),
        trace = join(root, "engine-writes"),
        b = new TestBridge(root, {
          LD_PRELOAD: faultShim(),
          NH_TEST_RECORDING_FAILURE: control,
          NH_TEST_BRIDGE_PID_FILE: owner,
          NH_TEST_ENGINE_WRITES: trace,
        });
      try {
        const g = await b.newGame(),
          id = g.sessionId,
          before = text(root, id, "input.log.jsonl");
        writeFileSync(owner, String(b.proc.pid));
        writeFileSync(control, mode);
        const r = await b.call("act", {
          sessionId: id,
          action: "wait",
          requestId: "not-delivered",
        });
        expect(r.error).toBeDefined();
        expect(r.storage.status).toBe("degraded");
        expect(r.observation.turn).toBe(1);
        expect(existsSync(trace) ? readFileSync(trace, "utf8") : "").toBe("");
        const log = text(root, id, "input.log.jsonl");
        if (mode === "sidecar") expect(log).toBe(before);
        else expect(log.length).toBeGreaterThan(before.length);
        await b.call("act", {
          sessionId: id,
          action: "wait",
          requestId: "must-not-run",
        });
        expect(text(root, id, "input.log.jsonl")).toBe(log);
        unlinkSync(control);
        const resumed = await b.call("resume", { sessionId: id });
        expect(readFileSync(trace, "utf8").length).toBeGreaterThan(0); // Positive control: replay really writes.
        if (mode === "sidecar") {
          expect(resumed.error).toBeUndefined();
          expect(resumed.observation.turn).toBe(1);
          expect(
            (
              await b.call("act", {
                sessionId: id,
                action: "wait",
                requestId: "not-delivered",
              })
            ).observation.turn,
          ).toBe(2);
        } else {
          expect(resumed.error.code).toBe("recoveryRequired");
          expect(resumed.decision).toBeNull();
          expect(text(root, id, "input.log.jsonl")).toBe(log);
        }
      } finally {
        try {
          unlinkSync(control);
        } catch {}
        await b.close();
      }
    },
    15000,
  );
