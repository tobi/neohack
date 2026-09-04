import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { TestBridge, testDirectory, ROOT } from "./bridge-harness";
import { createReconstructor } from "../src/reconstruct";
const text = (root: string, id: string, file = "input.log.jsonl") =>
  readFileSync(join(root, id, file), "utf8");
async function floor(b: TestBridge) {
  let g = await b.newGame();
  const id = g.sessionId;
  for (const name of ["food ration", "dagger"]) {
    const item = g.observation.inventory.find((i: any) =>
      i.label.includes(name),
    );
    g = await b.call("act", {
      sessionId: id,
      action: "drop",
      item: { id: item.id },
    });
    expect(g.error).toBeUndefined();
  }
  expect(g.observation.here.items).toHaveLength(2);
  return {
    id,
    g,
    food: g.observation.here.items.find((i: any) => i.category === "food"),
  };
}
function picked(r: any) {
  expect(r.error).toBeUndefined();
  expect(r.outcome.status).toBe("completed");
  expect(r.outcome.turnsElapsed).toBe(1);
  expect(r.observation.inventory.some((i: any) => i.category === "food")).toBe(
    true,
  );
  expect(r.observation.here.items).toHaveLength(1);
  expect(r.observation.here.items[0].category).toBe("weapon");
}

test("two-object pickup binds the chosen identity, costs one turn and has durable exactly-once receipts", async () => {
  const root = testDirectory("menu-object"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const { id, food } = await floor(a),
      deed = {
        sessionId: id,
        action: "pickup",
        item: { id: food.id },
        requestId: "pick-food",
      };
    const result = await a.call("act", deed);
    picked(result);
    const input = text(root, id);
    expect(await a.call("act", deed)).toEqual(result);
    expect(text(root, id)).toBe(input);
    const stale = await a.call("act", {
      sessionId: id,
      action: "pickup",
      item: { id: food.id },
    });
    expect(stale.error.code).toBe("staleReference");
    expect(text(root, id)).toBe(input);
    await a.close();
    const restored = await b.call("resume", { sessionId: id });
    expect(restored.error).toBeUndefined();
    expect(restored.observation).toEqual(result.observation);
    expect(await b.call("act", deed)).toEqual(result);
    expect(text(root, id)).toBe(input);
  } finally {
    await a.close();
    await b.close();
  }
});

test("auto-accelerator menu choices exclude headers, survive cold resume, and continue the original pickup", async () => {
  const root = testDirectory("menu-choice"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const { id } = await floor(a);
    const p = await a.call("act", {
      sessionId: id,
      action: "pickup",
      requestId: "choose-food",
    });
    expect(p.decision.options).toHaveLength(2);
    expect(p.decision.options.every((o: any) => Number.isInteger(o.id))).toBe(
      true,
    );
    expect(p.outcome.status).toBe("needsChoice");
    const option = p.decision.options.find((o: any) =>
      o.label.includes("food ration"),
    );
    expect(option).toBeDefined();
    const input = text(root, id);
    expect((await a.call("get_state", { sessionId: id })).decision).toEqual(
      p.decision,
    );
    expect(text(root, id)).toBe(input);
    await a.close();
    const resumed = await b.call("resume", { sessionId: id });
    expect(resumed.error).toBeUndefined();
    expect(resumed.decision).toEqual(p.decision);
    expect(text(root, id)).toBe(input);
    const bad = await b.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      choose: 0,
    });
    expect(bad.error.code).toBe("invalidAnswer");
    expect(bad.decision).toEqual(p.decision);
    expect(text(root, id)).toBe(input);
    const result = await b.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      choose: option.id,
      requestId: "answer-food",
    });
    picked(result);
    expect(text(root, id).trimEnd().split("\n")).toHaveLength(
      input.trimEnd().split("\n").length + 1,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("a carried item is not a pickup candidate and cannot accidentally collect an unrelated single floor object", async () => {
  const root = testDirectory("pickup-carried"),
    b = new TestBridge(root);
  try {
    let g = await b.newGame(),
      id = g.sessionId;
    const food = g.observation.inventory.find(
        (i: any) => i.category === "food",
      ),
      dagger = g.observation.inventory.find((i: any) =>
        i.label.includes("dagger"),
      );
    g = await b.call("act", {
      sessionId: id,
      action: "drop",
      item: { id: food.id },
    });
    const input = text(root, id);
    for (const item of [{ id: dagger.id }, "dagger"]) {
      const r = await b.call("act", { sessionId: id, action: "pickup", item });
      expect(r.error).toBeDefined();
      expect(r.observation.here.items).toHaveLength(1);
      expect(r.observation.turn).toBe(g.observation.turn);
      expect(text(root, id)).toBe(input);
    }
  } finally {
    await b.close();
  }
});

function filter(
  root: string,
  mode: "labels" | "legacy" | "no-binding" | "changed-binding",
) {
  const wrapper = join(root, "menu-telemetry-filter");
  // Real engine; alter only telemetry presentation/availability. No fabricated
  // game objects, input requests, answers, or elapsed turns.
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun\nimport {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {existsSync} from 'node:fs';
 const mode=${JSON.stringify(mode)};const child=spawn(${JSON.stringify(`${ROOT}/upstream/playground/nethack`)},[],{stdio:['inherit','pipe','inherit']});
 createInterface({input:child.stdout}).on('line',line=>{const d=JSON.parse(line);
 if(d.method==='menu_object'&&(mode==='legacy'||mode==='no-binding'))return;
 if(d.method==='menu_object'&&mode==='changed-binding'&&existsSync(${JSON.stringify(join(root, "change-bindings"))}))d.params.objectId+=100000;
 if(d.method==='menu_item'){if(mode==='legacy')delete d.params.selectable;else if(mode==='labels'){d.params.text='Identical presentation';d.params.accel=120;}}
 process.stdout.write(JSON.stringify(d)+'\\n');});child.on('exit',code=>process.exit(code??1));\n`,
  );
  chmodSync(wrapper, 0o700);
  return wrapper;
}

test("object pickup and header rejection do not depend on menu labels, ordering, or accelerator guesses", async () => {
  const root = testDirectory("menu-labels"),
    a = new TestBridge(root, { ENGINE_CMD: filter(root, "labels") }),
    b = new TestBridge(root),
    c = new TestBridge(root);
  try {
    const { id, food } = await floor(a);
    const p = await a.call("act", { sessionId: id, action: "pickup" });
    expect(p.decision.options).toHaveLength(2);
    expect(
      p.decision.options.every(
        (o: any) => o.label === "Identical presentation",
      ),
    ).toBe(true);
    const input = text(root, id);
    const bad = await a.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      choose: 0,
    });
    expect(bad.error.code).toBe("invalidAnswer");
    expect(text(root, id)).toBe(input);
    await a.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      cancel: true,
    });
    picked(
      await a.call("act", {
        sessionId: id,
        action: "pickup",
        item: { id: food.id },
      }),
    );
    await a.close();
    const r = await b.call("resume", { sessionId: id });
    expect(r.error).toBeUndefined();
    expect(r.observation.here.items).toHaveLength(1);
    await b.close();
    const lines = text(root, id).trimEnd().split("\n").map(JSON.parse),
      last = lines.findLast((v: any) => v.result?.picks?.length);
    last.result.picks = [0];
    const damaged = lines.map((v) => JSON.stringify(v)).join("\n") + "\n";
    writeFileSync(join(root, id, "input.log.jsonl"), damaged);
    const meta = JSON.parse(text(root, id, "meta.json"));
    meta.inputBytes = Buffer.byteLength(damaged);
    writeFileSync(join(root, id, "meta.json"), JSON.stringify(meta));
    expect((await c.call("resume", { sessionId: id })).error.code).toBe(
      "replayMismatch",
    );
    expect(text(root, id)).toBe(damaged);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

for (const mode of ["legacy", "no-binding"] as const)
  test(`${mode} telemetry cannot silently bind a floor object by its label or ordinal`, async () => {
    const root = testDirectory("menu-legacy"),
      a = new TestBridge(root, { ENGINE_CMD: filter(root, mode) }),
      b = new TestBridge(root);
    try {
      const { id, g, food } = await floor(a);
      const result = await a.call("act", {
        sessionId: id,
        action: "pickup",
        item: { id: food.id },
      });
      expect(result.error.code).toBe("itemMappingUnavailable");
      expect(result.outcome.turnsElapsed).toBe(0);
      expect(result.observation.here.items).toEqual(g.observation.here.items);
      const last = JSON.parse(text(root, id).trimEnd().split("\n").at(-1)!);
      expect(last.result.picks).toEqual([]);
      await a.close();
      expect((await b.call("resume", { sessionId: id })).error).toBeUndefined();
    } finally {
      await a.close();
      await b.close();
    }
  });

test("menu cancellation leaves both objects, and an explicit multi-selection collects only the offered rows", async () => {
  const root = testDirectory("menu-multi"),
    b = new TestBridge(root);
  try {
    const { id, g } = await floor(b);
    let p = await b.call("act", { sessionId: id, action: "pickup" });
    const cancelled = await b.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      cancel: true,
    });
    expect(cancelled.observation.turn).toBe(g.observation.turn);
    expect(cancelled.observation.here.items).toEqual(g.observation.here.items);
    p = await b.call("act", { sessionId: id, action: "pickup" });
    expect(p.decision.selection.max).toBe(2);
    const result = await b.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      choose: p.decision.options.map((o: any) => o.id),
    });
    expect(result.error).toBeUndefined();
    expect(result.outcome.turnsElapsed).toBe(1);
    expect(result.observation.here.items).toHaveLength(0);
    expect(
      result.observation.inventory.some((i: any) => i.label.includes("dagger")),
    ).toBe(true);
    expect(
      result.observation.inventory.some((i: any) => i.category === "food"),
    ).toBe(true);
  } finally {
    await b.close();
  }
});

test("changed pending object bindings cannot be rebound to an old menu decision", async () => {
  const root = testDirectory("menu-fingerprint"),
    a = new TestBridge(root, { ENGINE_CMD: filter(root, "changed-binding") }),
    b = new TestBridge(root);
  try {
    const { id } = await floor(a);
    expect(
      (await a.call("act", { sessionId: id, action: "pickup" })).decision
        .options,
    ).toHaveLength(2);
    await a.close();
    const input = text(root, id);
    writeFileSync(
      join(root, "change-bindings"),
      "test-only telemetry mutation",
    );
    const r = await b.call("resume", { sessionId: id });
    expect(r.error.code).toBe("recoveryRequired");
    expect(r.decision).toBeNull();
    expect(text(root, id)).toBe(input);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a bound, zero-accelerator pickup replays in the real isolated reconstruction worker", async () => {
  const root = testDirectory("menu-reconstruction"),
    b = new TestBridge(root);
  try {
    const { id, food } = await floor(b);
    const result = await b.call("act", {
      sessionId: id,
      action: "pickup",
      item: { id: food.id },
    });
    picked(result);
    await b.close();
    const input = text(root, id),
      manager = createReconstructor(root);
    const started = await manager.start(id);
    expect(started.status).toBe(202);
    const job = await manager.wait((started.body as any).job.id);
    expect(job.state).toBe("completed");
    expect(job.provenance.verification).toBe("unverified");
    const frames = text(root, job.archiveId, "perceptions.jsonl")
        .trimEnd()
        .split("\n")
        .map(JSON.parse),
      last = frames.at(-1).response;
    expect(last.observation.inventory).toEqual(result.observation.inventory);
    expect(last.observation.here).toEqual(result.observation.here);
    expect(last.observation.turn).toBe(result.observation.turn);
    expect(text(root, id)).toBe(input);
  } finally {
    await b.close();
  }
}, 15000);
