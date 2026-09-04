import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { TestBridge, testDirectory, ROOT } from "./bridge-harness";
const input = (root: string, id: string) =>
  readFileSync(join(root, id, "input.log.jsonl"), "utf8");
const wizard = (b: TestBridge) =>
  b.call("new_game", {
    seed: 42,
    name: "Equipment",
    role: "wizard",
    race: "human",
    gender: "female",
    align: "neutral",
  });
const worn = (r: any, id: string) =>
  r.observation.inventory.find((i: any) => i.id === id).usage.includes("worn");
async function putRing(
  b: TestBridge,
  id: string,
  item: string,
  action = "equip",
) {
  let r = await b.call("act", { sessionId: id, action, item: { id: item } });
  if (r.decision) {
    expect(r.decision.kind).toBe("choice");
    expect(r.decision.options.map((o: any) => o.label).sort()).toEqual([
      "Left",
      "Right",
    ]);
    r = await b.call("act", {
      sessionId: id,
      replyTo: r.decision.id,
      choose: r.decision.options.find((o: any) => o.label === "Right").id,
    });
  }
  expect(r.error).toBeUndefined();
  expect(worn(r, item)).toBe(true);
  return r;
}

test("removing a ring removes only that ring, never the sole worn cloak; receipts survive cold resume", async () => {
  const root = testDirectory("ring-remove"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const g = await wizard(a),
      id = g.sessionId,
      ring = g.observation.inventory.find((i: any) => i.category === "ring"),
      cloak = g.observation.inventory.find((i: any) => i.category === "armor");
    await putRing(a, id, ring.id);
    const deed = {
      sessionId: id,
      action: "remove",
      item: { id: ring.id },
      requestId: "ring-off",
    };
    const r = await a.call("act", deed);
    expect(r.error).toBeUndefined();
    expect(r.outcome.turnsElapsed).toBe(1);
    expect(worn(r, ring.id)).toBe(false);
    expect(worn(r, cloak.id)).toBe(true);
    const log = input(root, id);
    expect(await a.call("act", deed)).toEqual(r);
    expect(input(root, id)).toBe(log);
    await a.close();
    const restored = await b.call("resume", { sessionId: id });
    expect(restored.error).toBeUndefined();
    expect(restored.observation).toEqual(r.observation);
    expect(await b.call("act", deed)).toEqual(r);
    expect(input(root, id)).toBe(log);
  } finally {
    await a.close();
    await b.close();
  }
});

test("equipment candidates reflect current physical use and invalid targets cannot remove or wear substitutes", async () => {
  const root = testDirectory("equipment-candidates"),
    b = new TestBridge(root);
  try {
    let g = await wizard(b),
      id = g.sessionId,
      ring = g.observation.inventory.find((i: any) => i.category === "ring"),
      cloak = g.observation.inventory.find((i: any) => i.category === "armor");
    const before = input(root, id);
    for (const [action, item] of [
      ["remove", ring.id],
      ["equip", cloak.id],
    ]) {
      const r = await b.call("act", {
        sessionId: id,
        action,
        item: { id: item },
      });
      expect(r.error).toBeDefined();
      expect(r.observation.turn).toBe(1);
      expect(worn(r, cloak.id)).toBe(true);
      expect(worn(r, ring.id)).toBe(false);
      expect(input(root, id)).toBe(before);
    }
    g = await b.call("act", { sessionId: id, action: "remove" });
    expect(g.decision.options.map((o: any) => o.id)).toEqual([cloak.id]);
    expect(input(root, id)).toBe(before);
    await b.call("act", {
      sessionId: id,
      replyTo: g.decision.id,
      cancel: true,
    });
    g = await b.call("act", { sessionId: id, action: "equip" });
    expect(g.decision.options).toHaveLength(2);
    expect(g.decision.options.every((o: any) => o.id !== cloak.id)).toBe(true);
    expect(input(root, id)).toBe(before);
    await b.call("act", {
      sessionId: id,
      replyTo: g.decision.id,
      cancel: true,
    });
  } finally {
    await b.close();
  }
});

test("synthetic equipment selection and a pending hand choice both survive cold resume without restarting the intent", async () => {
  const root = testDirectory("equipment-continuation"),
    a = new TestBridge(root),
    b = new TestBridge(root),
    c = new TestBridge(root);
  try {
    const g = await wizard(a),
      id = g.sessionId,
      ring = g.observation.inventory.find((i: any) => i.category === "ring"),
      cloak = g.observation.inventory.find((i: any) => i.category === "armor");
    const itemChoice = await a.call("act", {
        sessionId: id,
        action: "equip",
        requestId: "equip-choice",
      }),
      before = input(root, id);
    await a.close();
    expect((await b.call("resume", { sessionId: id })).decision).toEqual(
      itemChoice.decision,
    );
    expect(input(root, id)).toBe(before);
    const hand = await b.call("act", {
      sessionId: id,
      replyTo: itemChoice.decision.id,
      item: { id: ring.id },
      requestId: "select-ring",
    });
    expect(hand.error).toBeUndefined();
    expect(hand.decision.kind).toBe("choice");
    expect(hand.decision.options.map((o: any) => o.label).sort()).toEqual([
      "Left",
      "Right",
    ]);
    const atHand = input(root, id);
    expect((await b.call("get_state", { sessionId: id })).decision).toEqual(
      hand.decision,
    );
    expect(input(root, id)).toBe(atHand);
    await b.close();
    const restored = await c.call("resume", { sessionId: id });
    expect(restored.error).toBeUndefined();
    expect(restored.decision).toEqual(hand.decision);
    expect(input(root, id)).toBe(atHand);
    const r = await c.call("act", {
      sessionId: id,
      replyTo: hand.decision.id,
      choose: hand.decision.options.find((o: any) => o.label === "Left").id,
      requestId: "left-hand",
    });
    expect(r.error).toBeUndefined();
    expect(r.outcome.turnsElapsed).toBe(1);
    expect(worn(r, ring.id)).toBe(true);
    expect(worn(r, cloak.id)).toBe(true);
    expect(input(root, id).trimEnd().split("\n")).toHaveLength(
      atHand.trimEnd().split("\n").length + 1,
    );
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test("ring-hand cancellation consumes no turn, and targeted accessory removal preserves the other ring", async () => {
  const root = testDirectory("two-rings"),
    b = new TestBridge(root);
  try {
    const g = await wizard(b),
      id = g.sessionId,
      rings = g.observation.inventory.filter((i: any) => i.category === "ring"),
      cloak = g.observation.inventory.find((i: any) => i.category === "armor");
    const p = await b.call("act", {
      sessionId: id,
      action: "wear",
      item: { id: rings[0].id },
    });
    const cancelled = await b.call("act", {
      sessionId: id,
      replyTo: p.decision.id,
      cancel: true,
    });
    expect(cancelled.observation.turn).toBe(1);
    expect(worn(cancelled, rings[0].id)).toBe(false);
    expect(worn(cancelled, cloak.id)).toBe(true);
    await putRing(b, id, rings[0].id, "wear");
    await putRing(b, id, rings[1].id);
    const r = await b.call("act", {
      sessionId: id,
      action: "takeoff",
      item: { id: rings[1].id },
    });
    expect(r.error).toBeUndefined();
    expect(r.outcome.turnsElapsed).toBe(1);
    expect(worn(r, rings[0].id)).toBe(true);
    expect(worn(r, rings[1].id)).toBe(false);
    expect(worn(r, cloak.id)).toBe(true);
  } finally {
    await b.close();
  }
});

test("real body-armor occupations report five-turn removal/donning and resume without repeating them", async () => {
  const root = testDirectory("armor-occupation"),
    a = new TestBridge(root),
    b = new TestBridge(root);
  try {
    const g = await a.call("new_game", {
        seed: 42,
        name: "Armor",
        role: "samurai",
        race: "human",
        gender: "female",
        align: "lawful",
      }),
      id = g.sessionId,
      armor = g.observation.inventory.find((i: any) => i.category === "armor");
    const removed = await a.call("act", {
      sessionId: id,
      action: "remove",
      item: { id: armor.id },
    });
    expect(removed.error).toBeUndefined();
    expect(removed.outcome.turnsElapsed).toBe(5);
    expect(removed.observation.turn).toBe(6);
    expect(worn(removed, armor.id)).toBe(false);
    const deed = {
        sessionId: id,
        action: "wear",
        item: { id: armor.id },
        requestId: "wear-once",
      },
      equipped = await a.call("act", deed);
    expect(equipped.error).toBeUndefined();
    expect(equipped.outcome.turnsElapsed).toBe(5);
    expect(equipped.observation.turn).toBe(11);
    expect(worn(equipped, armor.id)).toBe(true);
    const log = input(root, id);
    expect(await a.call("act", deed)).toEqual(equipped);
    expect(input(root, id)).toBe(log);
    await a.close();
    expect((await b.call("resume", { sessionId: id })).observation).toEqual(
      equipped.observation,
    );
    expect(await b.call("act", deed)).toEqual(equipped);
    expect(input(root, id)).toBe(log);
  } finally {
    await a.close();
    await b.close();
  }
});

function telemetry(root: string, legacy: boolean | "access" = false) {
  const path = join(root, "equipment-filter");
  writeFileSync(
    path,
    `#!/usr/bin/env bun\nimport {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
 const child=spawn(${JSON.stringify(`${ROOT}/upstream/playground/nethack`)},[],{stdio:['inherit','pipe','inherit']});
 createInterface({input:child.stdout}).on('line',line=>{const d=JSON.parse(line);if(d.method==='perception')for(const i of d.params.inventory??[]){if(${JSON.stringify(legacy)}===true)delete i.usage;else if(${JSON.stringify(legacy)}==='access')delete i.armorAccessible;else if(i.class==='ring')i.label='a plain coat';else if(i.class==='armor')i.label='a glittering ring';}process.stdout.write(JSON.stringify(d)+'\\n');});child.on('exit',code=>process.exit(code??1));\n`,
  );
  chmodSync(path, 0o700);
  return path;
}

test("equipment routing uses engine class/use facts even when labels describe the wrong item class", async () => {
  const root = testDirectory("equipment-labels"),
    b = new TestBridge(root, { ENGINE_CMD: telemetry(root) });
  try {
    const g = await wizard(b),
      id = g.sessionId,
      ring = g.observation.inventory.find((i: any) => i.category === "ring"),
      cloak = g.observation.inventory.find((i: any) => i.category === "armor");
    expect(ring.label).toBe("a plain coat");
    expect(cloak.label).toBe("a glittering ring");
    await putRing(b, id, ring.id);
    let r = await b.call("act", {
      sessionId: id,
      action: "remove",
      item: { id: ring.id },
    });
    expect(r.error).toBeUndefined();
    expect(worn(r, ring.id)).toBe(false);
    expect(worn(r, cloak.id)).toBe(true);
    r = await b.call("act", {
      sessionId: id,
      action: "remove",
      item: { id: cloak.id },
    });
    expect(r.error).toBeUndefined();
    expect(worn(r, cloak.id)).toBe(false);
    r = await b.call("act", {
      sessionId: id,
      action: "equip",
      item: { id: cloak.id },
    });
    expect(r.error).toBeUndefined();
    expect(worn(r, cloak.id)).toBe(true);
    expect(worn(r, ring.id)).toBe(false);
  } finally {
    await b.close();
  }
});

for (const legacy of [false, true])
  test(`covered shirt removal never substitutes outer armor (${legacy ? "legacy access unknown" : "engine access facts"})`, async () => {
    const root = testDirectory("armor-layers"),
      b = new TestBridge(
        root,
        legacy ? { ENGINE_CMD: telemetry(root, "access") } : {},
      );
    try {
      let g = await b.call("new_game", {
          seed: 6,
          name: "Layers",
          role: "tourist",
          race: "human",
          gender: "female",
          align: "neutral",
        }),
        id = g.sessionId;
      const shirt = g.observation.inventory.find(
        (i: any) => i.category === "armor",
      );
      expect(worn(g, shirt.id)).toBe(true);
      g = await b.call("act", {
        sessionId: id,
        action: "move",
        direction: "east",
      });
      const mail = g.observation.here.items.find(
        (i: any) => i.category === "armor",
      );
      expect(mail.label).toContain("scale mail");
      g = await b.call("act", {
        sessionId: id,
        action: "pickup",
        item: { id: mail.id },
      });
      const carried = g.observation.inventory.find((i: any) =>
        i.label.includes("scale mail"),
      );
      g = await b.call("act", {
        sessionId: id,
        action: "equip",
        item: { id: carried.id },
      });
      expect(g.error).toBeUndefined();
      expect(worn(g, shirt.id)).toBe(true);
      expect(worn(g, carried.id)).toBe(true);
      const before = input(root, id),
        turn = g.observation.turn;
      const rejected = await b.call("act", {
        sessionId: id,
        action: "remove",
        item: { id: shirt.id },
      });
      expect(rejected.error).toBeDefined();
      expect(rejected.observation.turn).toBe(turn);
      expect(worn(rejected, shirt.id)).toBe(true);
      expect(worn(rejected, carried.id)).toBe(true);
      expect(input(root, id)).toBe(before);
      if (!legacy) {
        const offer = await b.call("act", { sessionId: id, action: "remove" });
        expect(offer.decision.options.map((i: any) => i.id)).toEqual([
          carried.id,
        ]);
        await b.call("act", {
          sessionId: id,
          replyTo: offer.decision.id,
          cancel: true,
        });
        expect(input(root, id)).toBe(before);
      }
    } finally {
      await b.close();
    }
  });

test("missing legacy physical-use facts cannot trigger an inferred equipment command", async () => {
  const root = testDirectory("equipment-legacy"),
    b = new TestBridge(root, { ENGINE_CMD: telemetry(root, true) });
  try {
    const g = await wizard(b),
      id = g.sessionId,
      ring = g.observation.inventory.find((i: any) => i.category === "ring"),
      before = input(root, id);
    for (const action of ["equip", "remove"]) {
      const r = await b.call("act", {
        sessionId: id,
        action,
        item: { id: ring.id },
      });
      expect(r.error.code).toBe("equipmentKnowledgeUnavailable");
      expect(r.observation.turn).toBe(1);
      expect(input(root, id)).toBe(before);
    }
  } finally {
    await b.close();
  }
});
