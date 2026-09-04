// Real engine regressions, not shape-only scenario placeholders.
// Build the bridge first. ENGINE_CMD/NHXCLI may point at isolated candidate binaries.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const ROOT = resolve(import.meta.dir, "../..");
const sessions = mkdtempSync(`${tmpdir()}/nh-contract-`);
let proc: any;
const waiters: any[] = [];
let stderr = "";
beforeAll(() => {
  proc = spawn(
    process.env.NHXCLI || `${ROOT}/mcp/bin/nhxcli`,
    [
      process.env.ENGINE_CMD || `${ROOT}/upstream/playground/nethack`,
      `${ROOT}/upstream/playground`,
      sessions,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  proc.stderr.on("data", (b: any) => (stderr += b));
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const w = waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      try {
        w.resolve(JSON.parse(line));
      } catch (e) {
        w.reject(e);
      }
    }
  });
  proc.on("exit", (code: any) => {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(Error(`Bridge exit ${code}: ${stderr}`));
    }
  });
});
afterAll(() => {
  proc?.stdin.end('{"tool":"shutdown"}\n');
});
function call(tool: string, args: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(Error(`Timeout: ${tool} ${stderr}`));
    }, 15000);
    waiters.push({ resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ tool, ...args }) + "\n");
  });
}
async function game(
  fn: (g: any, a: (v: any) => Promise<any>) => Promise<void>,
  seed = 42,
) {
  const g = await call("new_game", {
    name: "Contract",
    seed,
    role: "valkyrie",
    race: "dwarf",
    gender: "female",
    align: "lawful",
  });
  expect(g.error).toBeUndefined();
  try {
    await fn(g, (v) => call("act", { sessionId: g.sessionId, ...v }));
  } finally {
    await call("end_session", { sessionId: g.sessionId });
  }
}

test("food candidates are read-only, include the ration here, never a spear", () =>
  game(async (g, a) => {
    const ration = g.observation.inventory.find((i: any) =>
      i.label.includes("food ration"),
    );
    expect(ration.category).toBe("food");
    const dropped = await a({ action: "drop", item: { id: ration.id } });
    expect(dropped.error).toBeUndefined();
    expect(
      dropped.observation.inventory.some((i: any) => i.id === ration.id),
    ).toBe(false);
    expect(dropped.observation.here.known).toBe(true);
    expect(dropped.observation.here.items[0].label).toContain("food ration");
    const before = await call("get_state", { sessionId: g.sessionId });
    const inputsBefore = readFileSync(
      `${sessions}/${g.sessionId}/input.log.jsonl`,
      "utf8",
    );
    const food = await a({ action: "eat" });
    expect(food.outcome.status).toBe("needsChoice");
    expect(food.observation.turn).toBe(before.observation.turn);
    expect(food.outcome.turnsElapsed).toBe(0);
    expect(
      readFileSync(`${sessions}/${g.sessionId}/input.log.jsonl`, "utf8"),
    ).toBe(inputsBefore);
    expect(food.decision.options.length).toBe(1);
    expect(food.decision.options[0].location).toBe("here");
    expect(food.decision.options[0].label).toContain("food ration");
    const peek = await call("get_state", { sessionId: g.sessionId });
    expect(peek.decision).toEqual(food.decision);
    await a({ replyTo: food.decision.id, cancel: true });
  }));

test("a missing kick direction returns an answerable target; cancellation settles", () =>
  game(async (g, a) => {
    const ask = await a({ action: "kick" });
    expect(ask.outcome.status).toBe("needsChoice");
    expect(ask.decision.kind).toBe("target");
    expect(ask.decision.allowedTargets).toContain("direction");
    const peek = await call("get_state", { sessionId: g.sessionId });
    expect(peek.decision).toEqual(ask.decision);
    const no = await a({ replyTo: ask.decision.id, cancel: true });
    expect(no.decision).toBeNull();
    expect(no.observation.turn).toBe(g.observation.turn);
  }));

test("request fingerprints reject changed item, target, and decision answers", () =>
  game(async (g, a) => {
    const first = await a({
      action: "kick",
      target: { direction: "north" },
      requestId: "kick-1",
    });
    expect(
      await a({
        action: "kick",
        target: { direction: "north" },
        requestId: "kick-1",
      }),
    ).toEqual(first);
    expect(
      (
        await a({
          action: "kick",
          target: { direction: "south" },
          requestId: "kick-1",
        })
      ).error.code,
    ).toBe("requestConflict");
    await a({ action: "wield", item: "dagger", requestId: "wield-1" });
    expect(
      (await a({ action: "wield", item: "spear", requestId: "wield-1" })).error
        .code,
    ).toBe("requestConflict");
    const prayer = await a({ action: "pray" });
    const no = await a({
      replyTo: prayer.decision.id,
      confirm: false,
      requestId: "answer-1",
    });
    expect(
      await a({
        replyTo: prayer.decision.id,
        confirm: false,
        requestId: "answer-1",
      }),
    ).toEqual(no);
    expect(
      (
        await a({
          replyTo: prayer.decision.id,
          confirm: true,
          requestId: "answer-1",
        })
      ).error.code,
    ).toBe("requestConflict");
  }));

test("opening and walking through a real door preserves openDoor terrain", () =>
  game(async (g, a) => {
    let r = g;
    for (const direction of ["south", "south", "west", "west"])
      r = await a({ action: "move", direction });
    expect(r.observation.you).toEqual({ x: 16, y: 7 });
    expect(
      r.observation.world.find((c: any) => c.x === 16 && c.y === 8).terrain
        .type,
    ).toBe("closedDoor");
    const opened = await a({ action: "move", direction: "south" });
    expect(
      opened.observation.world.find((c: any) => c.x === 16 && c.y === 8).terrain
        .type,
    ).toBe("openDoor");
    expect(opened.outcome.effects).toContain("openedDoor");
    const walked = await a({ action: "move", direction: "south" });
    expect(walked.observation.you).toEqual({ x: 16, y: 8 });
    expect(
      walked.observation.world.find((c: any) => c.x === 16 && c.y === 8).terrain
        .type,
    ).toBe("openDoor");
  }));

test("stale references cannot eat a dropped item by its former inventory handle", () =>
  game(async (g, a) => {
    const ration = g.observation.inventory.find(
      (i: any) => i.category === "food",
    );
    await a({ action: "drop", item: { id: ration.id } });
    const wrong = await a({ action: "eat", item: { id: ration.id } });
    expect(wrong.error.code).toBe("staleReference");
    expect(wrong.outcome.turnsElapsed).toBe(0);
  }));

test("live observations remain equivalent after get_state; no inventory peeks needed", () =>
  game(async (g, a) => {
    let r = g;
    for (let i = 0; i < 12; i++)
      r = await a({ action: "move", direction: i % 2 ? "north" : "south" });
    const peek = await call("get_state", { sessionId: g.sessionId });
    expect(peek.observation).toEqual(r.observation);
    expect(peek.decision).toEqual(r.decision);
    expect(r.observation.inventoryKnown).toBe(true);
  }));

test("pending item and target decisions survive read and deterministic resume", () =>
  game(async (g, a) => {
    const food = await a({ action: "eat" });
    const resumed = await call("resume", { sessionId: g.sessionId });
    expect(resumed.observation).toEqual(food.observation);
    expect(resumed.decision).toEqual(food.decision);
    await a({ replyTo: resumed.decision.id, cancel: true });
    const target = await a({ action: "kick" });
    const back = await call("resume", { sessionId: g.sessionId });
    expect(back.decision).toEqual(target.decision);
    const no = await a({ replyTo: back.decision.id, cancel: true });
    expect(no.decision).toBeNull();
  }));

test("the chosen food here is not picked up implicitly before eating", () =>
  game(async (g, a) => {
    const ration = g.observation.inventory.find(
      (i: any) => i.category === "food",
    );
    await a({ action: "drop", item: { id: ration.id } });
    const offer = await a({ action: "eat" });
    let ate = await a({
      replyTo: offer.decision.id,
      item: { id: offer.decision.options[0].id },
    });
    // An actual game confirmation is surfaced, never an item-letter prompt.
    if (ate.decision?.kind === "confirmation")
      ate = await a({ replyTo: ate.decision.id, confirm: true });
    expect(ate.error).toBeUndefined();
    expect(ate.decision).toBeNull();
    expect(ate.observation.turn).toBeGreaterThan(offer.observation.turn);
    expect(
      ate.observation.inventory.some((i: any) =>
        i.label.includes("food ration"),
      ),
    ).toBe(false);
  }));

test("perception journal is versioned, contiguous, and does not duplicate retries or reads", () =>
  game(async (g, a) => {
    const path = `${sessions}/${g.sessionId}/perceptions.jsonl`;
    const frames = () =>
      readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
    expect(frames().length).toBe(1);
    const moved = await a({
      action: "move",
      direction: "south",
      requestId: "record-once",
    });
    await a({ action: "move", direction: "south", requestId: "record-once" });
    await call("get_state", { sessionId: g.sessionId });
    const journal = frames();
    expect(journal.length).toBe(2);
    expect(journal.map((f) => f.sequence)).toEqual([0, 1]);
    expect(journal[1].format).toBe("neonethack.perception");
    expect(journal[1].version).toBe(1);
    expect(journal[1].response.observation).toEqual(moved.observation);
    expect(journal[1].response.events).toEqual(moved.events);
    expect(
      readFileSync(`${sessions}/${g.sessionId}/engine`).length,
    ).toBeGreaterThan(1000000);
  }));

test("an existing session id cannot truncate its input or perception history", () =>
  game(async (g, a) => {
    const path = `${sessions}/${g.sessionId}/input.log.jsonl`;
    const before = readFileSync(path, "utf8");
    const rejected = await call("new_game", {
      sessionId: g.sessionId,
      seed: 17,
      name: "Replacement",
    });
    expect(rejected.error.code).toBe("sessionExists");
    expect(readFileSync(path, "utf8")).toBe(before);
  }));

test("known stairs survive under the explorer and conditions have an explicit array", () =>
  game(async (g, a) => {
    expect(Array.isArray(g.observation.vitals.condition)).toBe(true);
    await a({ action: "move", direction: "south" });
    const back = await a({ action: "move", direction: "north" });
    const here = back.observation.world.find(
      (c: any) =>
        c.x === back.observation.you.x && c.y === back.observation.you.y,
    );
    expect(here.occupant.kind).toBe("self");
    expect(here.terrain.type).toBe("stairsUp");
  }));
