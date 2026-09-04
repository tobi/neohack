import { test, expect, afterEach } from "bun:test";
import { readFileSync, appendFileSync } from "node:fs";
import { TestBridge, testDirectory } from "./bridge-harness";
const bridges: TestBridge[] = [];
function bridge(root: string) {
  const b = new TestBridge(root);
  bridges.push(b);
  return b;
}
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close().catch(() => {});
});
const file = (root: string, id: string, name: string) =>
  readFileSync(`${root}/${id}/${name}`, "utf8");
async function waitForLease(root: string, id: string) {
  const guard = Bun.spawn(
    ["flock", "-w", "5", `${root}/${id}/.lease`, "true"],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(await guard.exited).toBe(0);
}

test("a second bridge cannot resume or alter a live run owned by another bridge", async () => {
  const root = testDirectory(),
    a = bridge(root),
    b = bridge(root);
  const g = await a.newGame();
  expect(g.error).toBeUndefined();
  const before = file(root, g.sessionId, "input.log.jsonl");
  const frames = file(root, g.sessionId, "perceptions.jsonl");
  const meta = file(root, g.sessionId, "meta.json");
  const rival = await b.call("resume", { sessionId: g.sessionId });
  expect(rival.error?.code).toBe("sessionBusy");
  expect(
    (await b.call("end_session", { sessionId: g.sessionId })).error?.code,
  ).toBe("noGame");
  expect(file(root, g.sessionId, "input.log.jsonl")).toBe(before);
  expect(file(root, g.sessionId, "perceptions.jsonl")).toBe(frames);
  expect(file(root, g.sessionId, "meta.json")).toBe(meta);
  const move = await a.call("act", {
    sessionId: g.sessionId,
    action: "move",
    direction: "south",
  });
  expect(move.observation.turn).toBe(g.observation.turn + 1);
});

test("ownership handoff reloads metadata even if the rival previously cached a stale sidecar", async () => {
  const root = testDirectory(),
    a = bridge(root),
    b = bridge(root);
  const g = await a.newGame();
  expect((await b.call("resume", { sessionId: g.sessionId })).error?.code).toBe(
    "sessionBusy",
  );
  const moved = await a.call("act", {
    sessionId: g.sessionId,
    action: "move",
    direction: "south",
    requestId: "move-once",
  });
  const offer = await a.call("act", { sessionId: g.sessionId, action: "eat" });
  await a.call("end_session", { sessionId: g.sessionId });
  const loaded = await b.call("resume", { sessionId: g.sessionId });
  expect(loaded.error).toBeUndefined();
  expect(loaded.revision).toBe(offer.revision);
  expect(loaded.observation).toEqual(offer.observation);
  expect(loaded.decision).toEqual(offer.decision);
  const retry = await b.call("act", {
    sessionId: g.sessionId,
    action: "move",
    direction: "south",
    requestId: "move-once",
  });
  expect(retry).toEqual(moved);
  const rows = file(root, g.sessionId, "perceptions.jsonl")
    .trim()
    .split("\n")
    .map(JSON.parse);
  expect(rows.map((r: any) => r.sequence)).toEqual(
    rows.map((_: any, i: number) => i),
  );
});

test("pending food choices survive complete bridge shutdown and cold restart", async () => {
  const root = testDirectory(),
    a = bridge(root);
  const g = await a.newGame();
  const offer = await a.call("act", { sessionId: g.sessionId, action: "eat" });
  await a.close();
  const b = bridge(root);
  const restored = await b.call("resume", { sessionId: g.sessionId });
  expect(restored.error).toBeUndefined();
  expect(restored.observation).toEqual(offer.observation);
  expect(restored.decision).toEqual(offer.decision);
  const ate = await b.call("act", {
    sessionId: g.sessionId,
    replyTo: restored.decision.id,
    item: { id: restored.decision.options[0].id },
  });
  expect(ate.error).toBeUndefined();
  expect(ate.observation.turn).toBeGreaterThan(restored.observation.turn);
  expect(ate.decision).toBeNull();
});

test("pending kick target survives cold restart and is executed exactly once", async () => {
  const root = testDirectory(),
    a = bridge(root);
  const g = await a.newGame();
  const offer = await a.call("act", { sessionId: g.sessionId, action: "kick" });
  expect(offer.decision.kind).toBe("target");
  await a.close();
  const b = bridge(root);
  const restored = await b.call("resume", { sessionId: g.sessionId });
  expect(restored.decision).toEqual(offer.decision);
  const kicked = await b.call("act", {
    sessionId: g.sessionId,
    replyTo: restored.decision.id,
    target: { direction: "south" },
    requestId: "one-kick",
  });
  expect(kicked.error).toBeUndefined();
  expect(kicked.decision).toBeNull();
  expect(kicked.observation.turn).toBe(g.observation.turn + 1);
  expect(
    await b.call("act", {
      sessionId: g.sessionId,
      replyTo: restored.decision.id,
      target: { direction: "south" },
      requestId: "one-kick",
    }),
  ).toEqual(kicked);
});

test("a completed confirmation receipt survives a crash without reconfirming", async () => {
  const root = testDirectory(),
    a = bridge(root);
  const g = await a.newGame();
  const ask = await a.call("act", { sessionId: g.sessionId, action: "pray" });
  const no = await a.call("act", {
    sessionId: g.sessionId,
    replyTo: ask.decision.id,
    confirm: false,
    requestId: "decline-once",
  });
  await a.close(true);
  await waitForLease(root, g.sessionId);
  const b = bridge(root);
  const restored = await b.call("resume", { sessionId: g.sessionId });
  expect(restored.error).toBeUndefined();
  expect(restored.decision).toBeNull();
  expect(restored.observation.turn).toBe(g.observation.turn);
  expect(
    await b.call("act", {
      sessionId: g.sessionId,
      replyTo: ask.decision.id,
      confirm: false,
      requestId: "decline-once",
    }),
  ).toEqual(no);
});

test("a receipt older than the sidecar cache still cannot execute again after restart", async () => {
  const root = testDirectory(),
    a = bridge(root);
  const g = await a.newGame();
  const first = await a.call("act", {
    sessionId: g.sessionId,
    action: "wait",
    requestId: "old-receipt",
  });
  for (let i = 0; i < 70; i++)
    await a.call("act", {
      sessionId: g.sessionId,
      action: "inventory",
      requestId: `lookup-${i}`,
    });
  await a.close();
  const b = bridge(root);
  const live = await b.call("resume", { sessionId: g.sessionId });
  const before = file(root, g.sessionId, "input.log.jsonl");
  const old = await b.call("act", {
    sessionId: g.sessionId,
    action: "wait",
    requestId: "old-receipt",
  });
  expect(old).toEqual(first);
  expect(file(root, g.sessionId, "input.log.jsonl")).toBe(before);
  expect(
    (await b.call("get_state", { sessionId: g.sessionId })).observation.turn,
  ).toBe(live.observation.turn);
});

test("a durable reservation without a receipt fails closed instead of replaying the intent", async () => {
  const root = testDirectory(),
    a = bridge(root);
  const g = await a.newGame();
  await a.close(true);
  await waitForLease(root, g.sessionId);
  // Model interruption after reservation commit but before any result exists.
  appendFileSync(
    `${root}/${g.sessionId}/requests.seen.jsonl`,
    JSON.stringify({ rid: "uncertain-request", argsKey: '{"action":"wait"}' }) +
      "\n",
  );
  const b = bridge(root);
  const restored = await b.call("resume", { sessionId: g.sessionId });
  const before = file(root, g.sessionId, "input.log.jsonl");
  const retry = await b.call("act", {
    sessionId: g.sessionId,
    action: "wait",
    requestId: "uncertain-request",
  });
  expect(retry.outcome.status).toBe("unknown");
  expect(retry.error.code).toBe("incompleteRequest");
  expect(retry.observation.turn).toBe(restored.observation.turn);
  expect(file(root, g.sessionId, "input.log.jsonl")).toBe(before);
});

test("a torn request-id journal blocks new actions without corrupting the game log", async () => {
  const root = testDirectory(),
    a = bridge(root);
  const g = await a.newGame();
  await a.close();
  appendFileSync(
    `${root}/${g.sessionId}/requests.seen.jsonl`,
    '{"rid":"partial',
  );
  const b = bridge(root);
  const restored = await b.call("resume", { sessionId: g.sessionId });
  expect(restored.error).toBeUndefined();
  const before = file(root, g.sessionId, "input.log.jsonl");
  const blocked = await b.call("act", {
    sessionId: g.sessionId,
    action: "wait",
    requestId: "must-not-act",
  });
  expect(blocked.error.code).toBe("storageError");
  expect(blocked.outcome.turnsElapsed).toBe(0);
  expect(file(root, g.sessionId, "input.log.jsonl")).toBe(before);
});

test.skipIf(process.platform !== "linux")(
  "a crashed bridge cannot release ownership while its paused engine still exists",
  async () => {
    const root = testDirectory(),
      a = bridge(root);
    const g = await a.newGame();
    const children = readFileSync(
      `/proc/${a.proc.pid}/task/${a.proc.pid}/children`,
      "utf8",
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    expect(children.length).toBe(1);
    const engine = children[0];
    let stopped = false;
    try {
      process.kill(engine, "SIGSTOP");
      stopped = true;
      await a.close(true);
      const b = bridge(root);
      const before = file(root, g.sessionId, "input.log.jsonl");
      expect(
        (await b.call("resume", { sessionId: g.sessionId })).error?.code,
      ).toBe("sessionBusy");
      expect(file(root, g.sessionId, "input.log.jsonl")).toBe(before);
      process.kill(engine, "SIGCONT");
      stopped = false;
      await waitForLease(root, g.sessionId);
      expect(
        (await b.call("resume", { sessionId: g.sessionId })).error,
      ).toBeUndefined();
    } finally {
      if (stopped) {
        try {
          process.kill(engine, "SIGCONT");
          process.kill(engine, "SIGTERM");
        } catch {}
      }
    }
  },
  15000,
);

test("closing an older world cannot strand another world through inherited pipe handles", async () => {
  const root = testDirectory(),
    a = bridge(root);
  const first = await a.newGame(42),
    second = await a.newGame(43);
  const ended = await a.call("end_session", { sessionId: first.sessionId });
  expect(ended.error).toBeUndefined();
  const waited = await a.call("act", {
    sessionId: second.sessionId,
    action: "wait",
  });
  expect(waited.observation.turn).toBe(second.observation.turn + 1);
  const b = bridge(root);
  expect(
    (await b.call("resume", { sessionId: first.sessionId })).error,
  ).toBeUndefined();
  const another = await a.call("act", {
    sessionId: second.sessionId,
    action: "wait",
  });
  expect(another.observation.turn).toBe(waited.observation.turn + 1);
});
