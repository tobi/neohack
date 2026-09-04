import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { TestBridge, testDirectory, ROOT } from "./bridge-harness";
import { stageLifesaving } from "./lifesaving-fixture";
import { createReconstructor } from "../src/reconstruct";
import { createRunStore } from "../src/runs";
import { parseRecording, LocalRecording } from "../../client/recording.js";
const input = (root: string, id: string) =>
  readFileSync(join(root, id, "input.log.jsonl"), "utf8");
const saves = (r: any) => r.events.filter((e: any) => e.type === "lifeSaved");
function alive(r: any, amulet: any, cause = "choking") {
  expect(r.error).toBeUndefined();
  expect(r.ended).toBe(false);
  expect(r.end).toBeUndefined();
  expect(r.decision).toBeNull();
  expect(r.observation.vitals.health).toBeGreaterThan(0);
  expect(r.observation.inventory.some((i: any) => i.id === amulet.id)).toBe(
    false,
  );
  expect(saves(r)).toHaveLength(1);
  expect(saves(r)[0]).toMatchObject({
    cause,
    health: 10,
    turn: 11,
  });
  expect(r.events.some((e: any) => e.type === "ended")).toBe(false);
}

test("an actual life-saving amulet averts choking; its receipt and alive state survive retry and cold resume", async () => {
  const root = testDirectory("lifesaved"),
    a = new TestBridge(root),
    b = new TestBridge(root),
    c = new TestBridge(root);
  try {
    const { id, amulet, warning } = await stageLifesaving(a.call.bind(a));
    const before = input(root, id);
    expect((await a.call("get_state", { sessionId: id })).decision).toEqual(
      warning.decision,
    );
    expect(input(root, id)).toBe(before);
    await a.close();
    const restored = await b.call("resume", { sessionId: id });
    expect(restored.error).toBeUndefined();
    expect(restored.decision).toEqual(warning.decision);
    expect(input(root, id)).toBe(before);
    const deed = {
        sessionId: id,
        replyTo: warning.decision.id,
        confirm: true,
        requestId: "survived-once",
      },
      saved = await b.call("act", deed);
    alive(saved, amulet);
    expect(saved.observation.turn).toBe(13);
    expect(saved.outcome.status).toBe("interrupted");
    const after = input(root, id);
    expect(await b.call("act", deed)).toEqual(saved);
    expect(input(root, id)).toBe(after);
    await b.close();
    const back = await c.call("resume", { sessionId: id });
    expect(back.error).toBeUndefined();
    expect(back.ended).toBe(false);
    expect(back.observation).toEqual(saved.observation);
    expect(await c.call("act", deed)).toEqual(saved);
    expect(input(root, id)).toBe(after);
    const wait = await c.call("act", { sessionId: id, action: "wait" });
    expect(wait.error).toBeUndefined();
    expect(wait.ended).toBe(false);
    expect(wait.observation.turn).toBe(14);
    expect(saves(wait)).toHaveLength(0);
    const store = createRunStore(root),
      exported = await (
        await store.handle(new Request(`http://localhost/runs/${id}/export`))
      ).text(),
      recording = new LocalRecording(parseRecording(exported));
    const pre = recording.frames.find(
        (f: any) => f.response.decision?.id === warning.decision.id,
      ),
      post = recording.frames.find(
        (f: any) => f.response.requestId === deed.requestId,
      );
    expect(
      pre.response.observation.inventory.some((i: any) => i.id === amulet.id),
    ).toBe(true);
    expect(saves(pre.response)).toHaveLength(0);
    expect(post.response).toEqual(saved);
    expect(recording.frames.every((f: any) => !f.response.end)).toBe(true);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
}, 20000);

test("carrying the same amulet without wearing it does not avert the same fatal choking", async () => {
  const root = testDirectory("lifesaving-control"),
    b = new TestBridge(root);
  try {
    const { id, amulet, warning } = await stageLifesaving(
      b.call.bind(b),
      false,
    );
    expect(
      warning.observation.inventory.find((i: any) => i.id === amulet.id).usage,
    ).not.toContain("worn");
    const died = await b.call("act", {
      sessionId: id,
      replyTo: warning.decision.id,
      confirm: true,
    });
    expect(died.ended).toBe(true);
    expect(died.end.kind).toBe("death");
    expect(died.end.cause).toBe("choked on a food ration");
    expect(died.observation.vitals.health).toBe(0);
    expect(saves(died)).toHaveLength(0);
    expect(
      died.observation.inventory.some((i: any) => i.id === amulet.id),
    ).toBe(true);
  } finally {
    await b.close();
  }
});

test("declining the actual choking-risk warning neither consumes the amulet nor invents a rescue", async () => {
  const root = testDirectory("lifesaving-decline"),
    b = new TestBridge(root);
  try {
    const { id, amulet, warning } = await stageLifesaving(b.call.bind(b));
    const no = await b.call("act", {
      sessionId: id,
      replyTo: warning.decision.id,
      confirm: false,
    });
    expect(no.error).toBeUndefined();
    expect(no.ended).toBe(false);
    expect(
      no.observation.inventory.find((i: any) => i.id === amulet.id).usage,
    ).toContain("worn");
    expect(saves(no)).toHaveLength(0);
    expect(no.events.some((e: any) => e.type === "ended")).toBe(false);
  } finally {
    await b.close();
  }
});

test("life-saving facts neither depend on narration nor disclose private killer descriptions", async () => {
  const root = testDirectory("lifesaving-facts"),
    wrapper = join(root, "narration-filter");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun\nimport {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
 const child=spawn(${JSON.stringify(`${ROOT}/upstream/playground/nethack`)},[],{stdio:['inherit','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>{const d=JSON.parse(line);if(d.method==='message')d.params.text='Opaque narration';if(d.method==='life_saved')d.params.cause='UNSEEN_ATTACKER_SECRET';process.stdout.write(JSON.stringify(d)+'\\n')});child.on('exit',code=>process.exit(code??1));\n`,
  );
  chmodSync(wrapper, 0o700);
  const b = new TestBridge(root, { ENGINE_CMD: wrapper });
  try {
    const { id, amulet, warning } = await stageLifesaving(b.call.bind(b));
    const saved = await b.call("act", {
      sessionId: id,
      replyTo: warning.decision.id,
      confirm: true,
    });
    alive(saved, amulet, "fatal harm");
    expect(JSON.stringify(saved)).not.toContain("UNSEEN_ATTACKER_SECRET");
    expect(
      saved.observation.heard.every((s: string) => s === "Opaque narration"),
    ).toBe(true);
  } finally {
    await b.close();
  }
});

test("sandboxed reconstruction retains witnessed life saving without upgrading historical verification", async () => {
  const root = testDirectory("lifesaving-reconstruction"),
    b = new TestBridge(root);
  try {
    const { id, amulet, warning } = await stageLifesaving(b.call.bind(b));
    const saved = await b.call("act", {
      sessionId: id,
      replyTo: warning.decision.id,
      confirm: true,
    });
    alive(saved, amulet);
    await b.close();
    const before = input(root, id),
      manager = createReconstructor(root),
      started = await manager.start(id);
    expect(started.status).toBe(202);
    const job = await manager.wait((started.body as any).job.id);
    expect(job.state).toBe("completed");
    expect(job.provenance.verification).toBe("unverified");
    const frames = readFileSync(
        join(root, job.archiveId, "perceptions.jsonl"),
        "utf8",
      )
        .trimEnd()
        .split("\n")
        .map(JSON.parse),
      events = frames.flatMap((f: any) => saves(f.response));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(saves(saved)[0]);
    expect(frames.at(-1).response.ended).toBe(false);
    expect(frames.at(-1).response.observation).toEqual(saved.observation);
    expect(input(root, id)).toBe(before);
  } finally {
    await b.close();
  }
}, 20000);
