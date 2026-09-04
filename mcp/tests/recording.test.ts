import { expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRunStore } from "../src/runs";
import {
  parseRecording,
  observationAt,
  RemoteRecording,
} from "../../client/recording.js";
const sample = (sequence: number) => ({
  format: "neonethack.perception",
  version: 1,
  sequence,
  recordedAt: 1,
  request: { tool: "act", action: "move", direction: "south" },
  response: {
    sessionId: "run1",
    revision: sequence,
    observation: {
      turn: sequence + 1,
      world: [{ x: 3, y: sequence, terrain: { type: "floor" } }],
      inventory: [],
      you: { x: 3, y: sequence },
    },
    events: [{ type: "heard", text: "You move." }],
    decision: null,
    ended: false,
  },
});

test("checkpoint replay can seek backwards without leaking future map state", () => {
  const frames = parseRecording(
    [sample(0), sample(1), sample(2)].map(JSON.stringify).join("\n"),
  );
  const future = observationAt(frames[2]);
  expect(future.observation.you.y).toBe(2);
  const past = observationAt(frames[0]);
  expect(past.observation.world).toEqual(sample(0).response.observation.world);
  past.observation.world.length = 0;
  expect(observationAt(frames[0]).observation.world.length).toBe(1);
});

test("legacy input logs and sequence gaps fail explicitly", () => {
  expect(() => parseRecording('{"jsonrpc":"2.0","method":"new_game"}')).toThrow(
    "Unsupported recording",
  );
  expect(() =>
    parseRecording([sample(0), sample(2)].map(JSON.stringify).join("\n")),
  ).toThrow("sequence gap");
});

test("archive browsing/seek are read-only and never call the engine", async () => {
  const root = await mkdtemp(`${tmpdir()}/nh-recording-`);
  await mkdir(`${root}/run1`);
  const frames = [sample(0), sample(1), sample(2)],
    lines = frames.map((f) => JSON.stringify(f) + "\n");
  let offset = 0;
  const idx = lines.map((line, sequence) => {
    const r = {
      sequence,
      offset,
      length: Buffer.byteLength(line),
      turn: sequence + 1,
    };
    offset += r.length;
    return r;
  });
  await writeFile(`${root}/run1/perceptions.jsonl`, lines.join(""));
  await writeFile(
    `${root}/run1/perceptions.index.jsonl`,
    idx.map(JSON.stringify).join("\n") + "\n",
  );
  await writeFile(
    `${root}/run1/run.json`,
    JSON.stringify({
      format: "neonethack.perception",
      version: 1,
      sessionId: "run1",
      frames: 3,
      updatedAt: 1,
    }),
  );
  const store = createRunStore(root),
    urls: string[] = [];
  const recording = await new RemoteRecording("run1", async (url: string) => {
    urls.push(url);
    expect(url.startsWith("/runs/")).toBe(true);
    return store.handle(new Request(`http://localhost${url}`));
  }).open();
  expect(observationAt(await recording.frame(2)).observation.you.y).toBe(2);
  expect(observationAt(await recording.frame(0)).observation.you.y).toBe(0);
  expect(urls.length).toBe(2); // index + one cached page, not a core action
  expect((await store.list())[0].replayReady).toBe(true);
  expect(
    (
      await store.handle(
        new Request("http://localhost/runs/run1/frames?from=-1"),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await store.handle(
        new Request("http://localhost/runs/run1/frames", { method: "POST" }),
      )
    ).status,
  ).toBe(405);
  expect(
    (await store.handle(new Request("http://localhost/runs/not-a-run/frames")))
      .status,
  ).toBe(404);
});
