import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProject } from "../../../examples/workshop/runtime.js";

test(
  "Curious imp continues through opening a door and visits new ground",
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "imp-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const trace = join(dir, "trace.jsonl");
    // Shared navigation adds free planning queries; budget counts those too.
    // Seed 12 exercises a witnessed door opening with this navigation policy,
    // which routes through a displayed tame ally instead of corking on it.
    const result = await runProject("curious-imp", {
      seed: 12,
      calls: 2000,
      trace,
    });
    assert.equal(result.reason, "stopped", result.error);
    assert.ok(result.moves >= 40);
    assert.ok(result.uniqueSquares >= 40);
    const frames = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const door = frames.findIndex((frame) =>
      frame.response?.outcome?.effects.includes("openedDoor"),
    );
    assert.ok(door > 0, "this real dungeon must exercise opening a door");
    assert.equal(frames[door].response.outcome.positionChanged, false);
    assert.ok(
      frames
        .slice(door + 1)
        .some((frame) => frame.response?.outcome?.positionChanged),
      "opening a door must not end the script",
    );
    assert.match(result.logs.at(-1), /retreat/);
    t.diagnostic(
      JSON.stringify({
        moves: result.moves,
        squares: result.uniqueSquares,
        stop: result.logs.at(-1),
      }),
    );
  },
);

test(
  "the exploration examples execute unchanged JavaScript and have distinct policies",
  { timeout: 90000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "exploration-policy-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const impTrace = join(dir, "imp.jsonl"), mapperTrace = join(dir, "mapper.jsonl");
    // Seed 20 lets all three policies reach their own stop within this budget
    // under the ally-displacing route policy.
    const imp = await runProject("curious-imp", { seed: 20, calls: 2000, trace: impTrace });
    const mapper = await runProject("cartographer", { seed: 20, calls: 2000, trace: mapperTrace });
    const fighter = await runProject("steady-fighter", { seed: 20, calls: 2000 });
    for (const result of [imp, mapper, fighter]) {
      assert.equal(result.reason, "stopped", result.error);
      assert.ok(result.moves > 40);
      assert.ok(result.uniqueSquares > 40);
      t.diagnostic(
        JSON.stringify({
          name: result.name,
          moves: result.moves,
          squares: result.uniqueSquares,
          depth: result.maxDepth,
        }),
      );
    }
    assert.ok(imp.maxDepth >= 2, "imp should follow disclosed stairs");
    assert.equal(
      mapper.maxDepth,
      1,
      "cartographer stays on its starting level",
    );
    // Compare the same floor; the imp's total also includes its later levels.
    const startingSquares = async (path) => {
      const frames = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
      const level = frames[0].initial.observation.location.id;
      return new Set(frames.map(frame => (frame.initial ?? frame.response)?.observation)
        .filter(o => o?.location.id === level && o.you)
        .map(o => `${o.you.x},${o.you.y}`)).size;
    };
    const impFirstLevel = await startingSquares(impTrace), mapperFirstLevel = await startingSquares(mapperTrace);
    t.diagnostic(JSON.stringify({ impFirstLevel, mapperFirstLevel }));
    assert.ok(mapperFirstLevel > impFirstLevel, "mapper covers more of the starting level");
    assert.ok(
      fighter.maxDepth >= 3,
      "fighter should progress through real encounters",
    );
    const first = await runProject("first-steps");
    assert.equal(first.reason, "stopped", first.error);
    assert.equal(first.calls, 1);
    assert.match(first.logs.at(-1), /Searched once/);
  },
);
