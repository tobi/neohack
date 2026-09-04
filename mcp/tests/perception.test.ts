import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { TestBridge, testDirectory, ROOT } from "./bridge-harness";

test("own equipment use is engine-reported and inspections are zero-input reads", async () => {
  const root = testDirectory("perception"),
    b = new TestBridge(root);
  try {
    const g = await b.newGame(),
      sid = g.sessionId;
    expect(g.observation.perception).toEqual({
      version: 2,
      inventory: "current",
      here: "current",
      equipment: "current",
    });
    const inv = g.observation.inventory,
      wielded = inv.find((i: any) => i.usage.includes("wielded")),
      alternate = inv.find((i: any) => i.usage.includes("alternate")),
      shield = inv.find((i: any) => i.usage.includes("worn"));
    expect(wielded.label).toContain("spear");
    expect(alternate.label).toContain("dagger");
    expect(shield.label).toContain("shield");
    const input = readFileSync(join(root, sid, "input.log.jsonl"), "utf8");
    for (const target of ["self", "here"]) {
      const r = await b.call("act", {
        sessionId: sid,
        action: "inspect",
        target,
      });
      expect(r.outcome.turnsElapsed).toBe(0);
      expect(r.observation).toEqual(g.observation);
    }
    expect(readFileSync(join(root, sid, "input.log.jsonl"), "utf8")).toBe(
      input,
    );
    const switched = await b.call("act", {
      sessionId: sid,
      action: "wield",
      item: { id: alternate.id },
    });
    expect(
      switched.observation.inventory.find((i: any) => i.id === alternate.id)
        .usage,
    ).toContain("wielded");
    expect(
      switched.observation.inventory.find((i: any) => i.id === wielded.id)
        .usage,
    ).not.toContain("wielded");
    const removed = await b.call("act", {
      sessionId: sid,
      action: "remove",
      item: { id: shield.id },
    });
    expect(
      removed.observation.inventory.find((i: any) => i.id === shield.id).usage,
    ).not.toContain("worn");
    expect((await b.call("resume", { sessionId: sid })).observation).toEqual(
      removed.observation,
    );
  } finally {
    await b.close();
  }
});

test("older-pin snapshot placement is marked last-known at a real mid-meal warning", async () => {
  const root = testDirectory("perception-compat"),
    wrapper = join(root, "rest-only-engine");
  // A transparent compatibility filter around the REAL engine. No fabricated
  // game state or answers: strip newer telemetry and expose only resting snapshots.
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun\nimport {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
 const child=spawn(${JSON.stringify(`${ROOT}/upstream/playground/nethack`)},[],{stdio:['inherit','pipe','inherit']});let snapshot;
 createInterface({input:child.stdout}).on('line',line=>{const d=JSON.parse(line);if(d.method==='perception'){delete d.params.perceptionVersion;for(const i of d.params.inventory??[])delete i.usage;snapshot=JSON.stringify(d);return;}if(d.method==='input'){if(d.params.kind==='poskey'&&snapshot)process.stdout.write(snapshot+'\\n');snapshot=null;}process.stdout.write(line+'\\n')});child.on('exit',code=>process.exit(code??1));\n`,
  );
  chmodSync(wrapper, 0o700);
  const b = new TestBridge(root, { ENGINE_CMD: wrapper });
  try {
    const g = await b.call("new_game", {
        seed: 42,
        name: "Compatibility",
        role: "tourist",
        race: "human",
        gender: "female",
        align: "neutral",
      }),
      sid = g.sessionId;
    expect(g.observation.perception.version).toBe(1);
    expect(g.observation.perception.inventory).toBe("current");
    expect(g.observation.perception.equipment).toBe("unknown");
    expect(
      g.observation.inventory.every((i: any) => i.usage === undefined),
    ).toBe(true);
    const item = g.observation.inventory.find((i: any) =>
      i.label.includes("food ration"),
    );
    const first = await b.call("act", {
      sessionId: sid,
      action: "eat",
      item: { id: item.id },
    });
    expect(first.observation.perception.inventory).toBe("current");
    const warning = await b.call("act", {
      sessionId: sid,
      action: "eat",
      item: { id: item.id },
    });
    expect(warning.decision.kind).toBe("confirmation");
    expect(warning.observation.perception.inventory).toBe("lastKnown");
    expect(warning.observation.perception.here).toBe("lastKnown");
    expect(warning.observation.inventory).toEqual(first.observation.inventory);
    const stopped = await b.call("act", {
      sessionId: sid,
      replyTo: warning.decision.id,
      confirm: false,
    });
    expect(stopped.observation.perception.inventory).toBe("current");
    expect(
      stopped.observation.inventory.some((i: any) =>
        i.label.includes("partly eaten"),
      ),
    ).toBe(true);
  } finally {
    await b.close();
  }
}, 15000);
