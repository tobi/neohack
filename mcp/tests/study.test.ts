import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { TestBridge, testDirectory, ROOT } from "./bridge-harness";
const input = (root: string, id: string) =>
  readFileSync(join(root, id, "input.log.jsonl"), "utf8");
async function fixture(b: TestBridge) {
  const g = await b.call("new_game", {
    seed: 2,
    name: "Study",
    role: "wizard",
    race: "human",
    gender: "female",
    align: "neutral",
  });
  const book = g.observation.inventory.find((i: any) =>
    i.label.includes("spellbook of jumping"),
  );
  expect(book).toBeDefined();
  expect(
    g.observation.world.some((c: any) => c.occupant?.kind === "creature"),
  ).toBe(true);
  return { g, id: g.sessionId, book };
}
const result = (r: any, status: string) =>
  r.events.filter(
    (e: any) =>
      e.type === "actionResult" && e.action === "read" && e.status === status,
  );

test("an actual approaching monster interrupts study; reads, retries and cold resume never silently restart it", async () => {
  const root = testDirectory("study-interrupted"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const { id, book } = await fixture(a);
    const question = await a.call("act", {
      sessionId: id,
      action: "read",
      item: { id: book.id },
      requestId: "study",
    });
    expect(question.decision.kind).toBe("confirmation");
    expect(question.decision.about).toContain("Refresh");
    const before = input(root, id);
    expect((await a.call("get_state", { sessionId: id })).decision).toEqual(
      question.decision,
    );
    expect(input(root, id)).toBe(before);
    const deed = {
        sessionId: id,
        replyTo: question.decision.id,
        confirm: true,
        requestId: "consent",
      },
      stopped = await a.call("act", deed);
    expect(stopped.error).toBeUndefined();
    expect(stopped.outcome.status).toBe("interrupted");
    expect(stopped.outcome.turnsElapsed).toBe(4);
    expect(stopped.observation.turn).toBe(5);
    expect(result(stopped, "interrupted")).toHaveLength(1);
    expect(result(stopped, "completed")).toHaveLength(0);
    expect(stopped.decision).toBeNull();
    expect(stopped.ended).toBe(false);
    const log = input(root, id);
    expect(await a.call("act", deed)).toEqual(stopped);
    expect(input(root, id)).toBe(log);
    await a.close();
    const resumed = await b.call("resume", { sessionId: id });
    expect(resumed.error).toBeUndefined();
    expect(resumed.observation).toEqual(stopped.observation);
    expect(resumed.decision).toBeNull();
    expect(await b.call("act", deed)).toEqual(stopped);
    expect(input(root, id)).toBe(log);
    const waited = await b.call("act", { sessionId: id, action: "wait" });
    expect(waited.observation.turn).toBe(6);
    expect(result(waited, "completed")).toHaveLength(0);
    const again = await b.call("act", {
      sessionId: id,
      action: "read",
      item: { id: book.id },
    });
    expect(again.decision.kind).toBe("confirmation");
    expect(again.decision.id).not.toBe(question.decision.id);
    const complete = await b.call("act", {
      sessionId: id,
      replyTo: again.decision.id,
      confirm: true,
    });
    expect(complete.error).toBeUndefined();
    expect(complete.outcome.status).toBe("completed");
    expect(complete.outcome.turnsElapsed).toBe(5);
    expect(result(complete, "completed")).toHaveLength(1);
    expect(result(complete, "interrupted")).toHaveLength(0);
    expect((await b.call("resume", { sessionId: id })).observation).toEqual(
      complete.observation,
    );
  } finally {
    await a.close();
    await b.close();
  }
}, 15000);

test("declining a saved study confirmation performs no occupation and preserves the book", async () => {
  const root = testDirectory("study-decline"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const { id, book } = await fixture(a),
      p = await a.call("act", {
        sessionId: id,
        action: "read",
        item: { id: book.id },
      });
    await a.close();
    const r = await b.call("resume", { sessionId: id });
    expect(r.error).toBeUndefined();
    expect(r.decision).toEqual(p.decision);
    const no = await b.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      confirm: false,
    });
    expect(no.observation.turn).toBe(1);
    expect(no.events.some((e: any) => e.type === "actionResult")).toBe(false);
    expect(no.observation.inventory.find((i: any) => i.id === book.id)).toEqual(
      book,
    );
    expect(no.decision).toBeNull();
  } finally {
    await a.close();
    await b.close();
  }
});

test("study outcome facts do not depend on parsing narration", async () => {
  const root = testDirectory("study-facts"),
    wrapper = join(root, "message-filter");
  // Presentation-only filter around the real engine. Physics, inputs, prompts,
  // occupation identity and structured facts remain untouched.
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun\nimport {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
 const child=spawn(${JSON.stringify(`${ROOT}/upstream/playground/nethack`)},[],{stdio:['inherit','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>{const d=JSON.parse(line);if(d.method==='message')d.params.text='Opaque narration';process.stdout.write(JSON.stringify(d)+'\\n')});child.on('exit',code=>process.exit(code??1));\n`,
  );
  chmodSync(wrapper, 0o700);
  const b = new TestBridge(root, { ENGINE_CMD: wrapper });
  try {
    const { id, book } = await fixture(b),
      p = await b.call("act", {
        sessionId: id,
        action: "read",
        item: { id: book.id },
      });
    const r = await b.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      confirm: true,
    });
    expect(r.error).toBeUndefined();
    expect(r.outcome.status).toBe("interrupted");
    expect(result(r, "interrupted")).toHaveLength(1);
    expect(
      r.observation.heard.every((m: string) => m === "Opaque narration"),
    ).toBe(true);
  } finally {
    await b.close();
  }
});
