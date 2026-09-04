import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TestBridge, testDirectory } from "./bridge-harness";
const all: TestBridge[] = [];
const make = (root: string) => {
  const b = new TestBridge(root);
  all.push(b);
  return b;
};
afterEach(async () => {
  for (const b of all.splice(0)) await b.close().catch(() => {});
});
const hash = async (p: string) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
async function fixture() {
  const root = testDirectory("reconstruction"),
    b = make(root),
    g = await b.newGame(42);
  let last = g;
  for (const direction of ["south", "south", "west", "west", "south", "south"])
    last = await b.call("act", {
      sessionId: g.sessionId,
      action: "move",
      direction,
    });
  await b.call("end_session", { sessionId: g.sessionId });
  const id = "legacy";
  await cp(`${root}/${g.sessionId}`, `${root}/${id}`, { recursive: true });
  for (const file of [
    "perceptions.jsonl",
    "perceptions.index.jsonl",
    "run.json",
  ])
    await rm(`${root}/${id}/${file}`);
  return { root, b, id, last };
}
async function reconstruct(f: any, id = "archive") {
  const output = testDirectory("reconstructed-output");
  const result = await f.b.call("reconstruct_run", {
    sessionId: f.id,
    outputRoot: output,
    archiveId: id,
  });
  return { output, result, path: `${output}/${id}` };
}

test("isolated reconstruction preserves source bytes and matches a fresh fixture final perception", async () => {
  const f = await fixture();
  const files = ["input.log.jsonl", "meta.json", "engine", "playground/nhdat"];
  const before = await Promise.all(
    files.map((p) => hash(`${f.root}/${f.id}/${p}`)),
  );
  const r = await reconstruct(f);
  expect(r.result.error).toBeUndefined();
  expect(r.result.frames).toBeGreaterThan(3);
  expect(r.result.provenance.verification).toBe("unverified");
  expect(r.result.provenance.complete).toBe(true);
  expect(
    await Promise.all(files.map((p) => hash(`${f.root}/${f.id}/${p}`))),
  ).toEqual(before);
  const frames = (await readFile(`${r.path}/perceptions.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  expect(frames.map((x) => x.sequence)).toEqual(frames.map((_, i) => i));
  expect(frames.at(-1).response.observation).toEqual(f.last.observation);
  expect(frames.every((x) => x.response.provenance?.readOnly === true)).toBe(
    true,
  );
  expect(
    frames.some((x) =>
      x.response.observation.world.some(
        (t: any) => t.terrain.type === "openDoor",
      ),
    ),
  ).toBe(true);
  expect(JSON.stringify(frames).includes('"key":')).toBe(false);
  await rename(r.path, `${f.root}/archive`);
  expect((await f.b.call("resume", { sessionId: "archive" })).error.code).toBe(
    "readOnlyRecording",
  );
  expect(
    (await f.b.call("new_game", { sessionId: "archive", seed: 5 })).error.code,
  ).toBe("readOnlyRecording");
});

test("a live source lease prevents reconstruction", async () => {
  const root = testDirectory("reconstruction-lock"),
    a = make(root),
    b = make(root),
    g = await a.newGame();
  const before = await hash(`${root}/${g.sessionId}/input.log.jsonl`);
  const r = await b.call("reconstruct_run", {
    sessionId: g.sessionId,
    outputRoot: testDirectory("reconstructed-output"),
    archiveId: "archive",
  });
  expect(r.error.code).toBe("sessionBusy");
  expect(await hash(`${root}/${g.sessionId}/input.log.jsonl`)).toBe(before);
});

test("malformed, duplicate-key, and seedless histories are rejected before engine execution", async () => {
  const f = await fixture(),
    path = `${f.root}/${f.id}/input.log.jsonl`,
    original = await readFile(path, "utf8");
  const variants = [
    original + '{"id":',
    original.replace('"seed":42', '"seed":null'),
    original.replace('"seed":42', '"seed":42,"seed":43'),
  ];
  for (const text of variants) {
    await writeFile(path, text);
    const r = await reconstruct(f);
    expect(r.result.error.code).toBe("invalidReconstruction");
    expect(await readFile(`${r.path}/input.log.jsonl`, "utf8")).toBe(text);
    expect(await Bun.file(`${r.path}/perceptions.jsonl`).exists()).toBe(false);
  }
});

test("a mismatched input id fails instead of publishing an apparently complete run", async () => {
  const f = await fixture(),
    path = `${f.root}/${f.id}/input.log.jsonl`;
  const lines = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  lines[2].id = 999999;
  await writeFile(path, lines.map(JSON.stringify).join("\n") + "\n");
  const r = await reconstruct(f);
  expect(r.result.error.code).toBe("replayDiverged");
  const meta = JSON.parse(await readFile(`${r.path}/run.json`, "utf8"));
  expect(meta.provenance.complete).toBe(false);
});

test("source engine is required; current engine is not substituted", async () => {
  const f = await fixture();
  await rm(`${f.root}/${f.id}/engine`);
  await rm(`${f.root}/${f.id}/playground/nethack`);
  expect((await reconstruct(f)).result.error.code).toBe("missingEngine");
});

test("shell input is rejected and leaves no complete reconstruction", async () => {
  const f = await fixture(),
    path = `${f.root}/${f.id}/input.log.jsonl`;
  const lines = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  // The first gameplay answer follows the opening narration acknowledgement.
  const row = lines.find(
    (x: any, i: number) => i > 2 && x.result && "key" in x.result,
  );
  row.result = { key: 33 };
  await writeFile(path, lines.map(JSON.stringify).join("\n") + "\n");
  expect((await reconstruct(f)).result.error.code).toBe(
    "unsupportedHistoricalCommand",
  );
});
