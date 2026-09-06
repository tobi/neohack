import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProject } from "../runtime.js";
import { loadProject, validateProject, botsRoot } from "../projects.js";

const script = (body) => ({
  name: "Runtime probe",
  files: {
    "main.js": `import {defineBot} from "neonethack";
const bot = defineBot({name: "Runtime probe"});
export default bot;
bot.on("turn", async ({hero, game, log}) => {${body}});`,
  },
});

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "workshop-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test(
  "raw JavaScript, relative imports, low/high APIs and journal run against the engine",
  { timeout: 20000 },
  async (t) => {
    const dir = await temporary(t);
    const project = script(`
    const discovery = await game.low.call("protocol_describe", {});
    if (!discovery.catalog) throw Error("Missing discovery");
    await game.low.call("session_observe", {sessionId: game.id});
    let denied = false;
    try { await game.low.call("session_create", {}); }
    catch (error) { denied = String(error).includes("workshop owns session creation"); }
    if (!denied) throw Error("Session creation allowed");
    await act(hero);
    log("HELPER_OK", tools.length);
    hero.stop();
  `);
    project.files["main.js"] = `import {act} from "./helper.js";
import {tools} from "neonethack/low";
${project.files["main.js"].replace('"neonethack"', '"neonethack/high"')}`;
    project.files["helper.js"] = "export const act = hero => hero.search();\n";
    await writeFile(
      join(dir, "source.json"),
      JSON.stringify({ artifact: JSON.stringify(project) }),
    );
    const trace = join(dir, "trace.jsonl");
    const result = await runProject(join(dir, "source.json"), { trace });
    assert.equal(result.reason, "stopped", result.error);
    assert.equal(result.calls, 3);
    assert.equal(result.turn, 2);
    assert.equal(result.moves, 0);
    assert.ok(result.logs.some((line) => /HELPER_OK \d+/.test(line)));
    const frames = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(frames.length, 4);
    assert.equal(frames[0].initial.observation.turn, 1);
    assert.equal(frames.at(-1).request.method, "game.search");
    assert.equal(frames.at(-1).response.outcome.status, "completed");
  },
);

test(
  "free observations count against the call budget without advancing game turns",
  { timeout: 20000 },
  async () => {
    const result = await runProject(
      script("while (true) await game.observe();"),
      { calls: 5 },
    );
    assert.equal(result.reason, "budget", result.error);
    assert.equal(result.calls, 5);
    assert.equal(result.turn, 1);
    assert.equal(result.moves, 0);
  },
);

test(
  "observing a movement receipt again does not inflate move counts",
  { timeout: 20000 },
  async () => {
    const result = await runProject(
      script(`
    const step = hero.steps.find(step => step.movement.intent === "step");
    await hero.go(step.direction);
    await game.observe();
    await game.observe();
    hero.stop();
  `),
    );
    assert.equal(result.reason, "stopped", result.error);
    assert.equal(result.calls, 3);
    assert.equal(result.moves, 1);
    assert.equal(result.uniqueSquares, 2);
  },
);

test(
  "timeouts terminate busy JavaScript, including a loop during module import",
  { timeout: 20000 },
  async () => {
    for (const project of [
      script("while (true) {}"),
      { files: { "main.js": "while (true) {}" } },
    ]) {
      const result = await runProject(project, { timeout: 500 });
      assert.equal(result.reason, "timeout", result.error);
      assert.equal(result.calls, 0);
      assert.ok(result.elapsedMs < 10000);
    }
  },
);

test(
  "script exceptions and process exits stop without replacement input",
  { timeout: 20000 },
  async () => {
    for (const body of ['throw Error("example exploded")', "process.exit(3)"]) {
      const result = await runProject(script(body));
      assert.equal(result.reason, "error");
      assert.match(result.error, /example exploded|Script exited \(3\)/);
      assert.equal(result.calls, 0);
    }
  },
);

test(
  "the supplied session is the only session scripts can access",
  { timeout: 20000 },
  async () => {
    const result = await runProject(
      script(
        'await game.low.call("session_observe", {sessionId: "another-session"});',
      ),
    );
    assert.equal(result.reason, "error");
    assert.match(result.error, /outside this test session/);
    assert.equal(result.calls, 0);
  },
);

test(
  "abort stops a busy script and releases the child process",
  { timeout: 20000 },
  async () => {
    const controller = new AbortController();
    const result = await runProject(script('log("started"); while (true) {}'), {
      signal: controller.signal,
      log: (text) => {
        if (text === "started") controller.abort();
      },
    });
    assert.equal(result.reason, "interrupted");
    assert.equal(result.calls, 0);
  },
);

test("project loading preserves helpers and accepts only workshop JavaScript filenames", async (t) => {
  const builtin = await loadProject("curious-imp");
  assert.deepEqual(await loadProject(join(botsRoot, "imp")), builtin);
  assert.deepEqual(await loadProject(join(botsRoot, "imp/main.js")), builtin);
  const dir = await temporary(t);
  for (const [name, code] of Object.entries(builtin.files))
    await writeFile(join(dir, name), code);
  assert.deepEqual((await loadProject(dir)).files, builtin.files);
  assert.deepEqual(
    (await loadProject(join(dir, "main.js"))).files,
    builtin.files,
  );
  for (const files of [
    { "main.ts": "" },
    { "main.js": "", "../escape.js": "" },
    { "main.js": 3 },
    { "main.js": "x".repeat(100001) },
  ]) {
    assert.throws(() => validateProject(files));
  }
  await assert.rejects(runProject(builtin, { calls: 0 }), /calls must/);
});
