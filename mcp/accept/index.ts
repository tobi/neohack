// Acceptance tests: API_DESING.md section 12, one test per contract
// clause. Helpers at the bottom keep scenarios deterministic. Scenario
// clauses without a staged scenario are explicit SKIPs, never vacuous passes.
// Additional real-engine regressions live in mcp/tests/core-contract.test.ts.
import { test, type TestCtx } from "../accept";
import { STAIRS_ROUTE } from "../tests/scenario-fixtures";

async function newWorld(t: TestCtx, identity = {}) {
  const f: any = await t.call("new_game", {
    seed: 7,
    name: "accept",
    role: "healer",
    race: "elf",
    gender: "female",
    align: "neutral",
    ...identity,
  });
  return f.sessionId as string;
}

async function settle(t: TestCtx, sid: string, d: any): Promise<any> {
  for (
    let i = 0;
    i < 6 && d.outcome?.status === "needsChoice" && d.decision && !d.ended;
    i++
  ) {
    const dec = d.decision;
    const ans: any =
      dec.kind === "confirmation"
        ? { replyTo: dec.id, confirm: false }
        : { replyTo: dec.id, cancel: true };
    d = await t.call("act", { sessionId: sid, ...ans });
  }
  return d;
}

test("100 actions from replies alone match a final snapshot", async (t) => {
  const sid = await newWorld(t);
  const dirs = ["north", "south", "east", "west"];
  let acc: any = await t.call("get_state", { sessionId: sid });
  for (let i = 0; i < 100 && !acc.ended; i++) {
    acc = await t.call("act", {
      sessionId: sid,
      action: "move",
      direction: dirs[i % dirs.length],
    });
    acc = await settle(t, sid, acc);
  }
  const live: any = await t.call("get_state", { sessionId: sid });
  t.assert(
    JSON.stringify(stripForEquiv(live)) === JSON.stringify(stripForEquiv(acc)),
    "accumulated perception differs from independent snapshot",
  );
});

function stripForEquiv(o: any) {
  return { observation: o.observation, decision: o.decision };
}

test("walk and exchange places with a real pet", async (t) => {
  const sid = await newWorld(t, {
    seed: 42,
    role: "valkyrie",
    race: "dwarf",
    align: "lawful",
  });
  const s: any = await t.call("get_state", { sessionId: sid });
  t.assert(
    s.observation.world.some(
      (c: any) => c.x === 19 && c.y === 6 && c.occupant?.kind === "ally",
    ),
    "fixture has no adjacent pet",
  );
  const r: any = await t.call("act", {
    sessionId: sid,
    action: "move",
    direction: "southeast",
  });
  t.assert(
    r.observation.you.x === 19 && r.observation.you.y === 6,
    "did not enter pet's square",
  );
  t.assert(
    r.outcome.effects.includes("swappedPlaces") &&
      !r.outcome.effects.includes("attacked"),
    "pet exchange was not a peaceful swap",
  );
  t.assert(r.outcome.turnsElapsed === 1, "wrong swap cost");
});

test("stairs: inspect here, descend, map replaced, stairs remembered", async (t) => {
  const sid = await newWorld(t, {
    seed: 7,
    role: "valkyrie",
    race: "dwarf",
    align: "lawful",
  });
  let r: any;
  for (const direction of STAIRS_ROUTE)
    r = await t.call("act", { sessionId: sid, action: "move", direction });
  t.assert(
    r.observation.you.x === 64 && r.observation.you.y === 3,
    "did not reach the actual stairs",
  );
  const s: any = await t.call("act", {
    sessionId: sid,
    action: "inspect",
    target: "here",
  });
  t.assert(
    s.outcome.effects.includes("inspectedHere") && s.outcome.turnsElapsed === 0,
    "inspection was not read-only",
  );
  const down: any = await t.call("act", {
    sessionId: sid,
    action: "climb",
    direction: "down",
  });
  t.assert(
    down.outcome.effects.includes("descendedStairs") &&
      down.outcome.turnsElapsed === 1,
    "did not descend",
  );
  t.assert(
    down.observation.location.id !== r.observation.location.id &&
      !down.observation.world.some((c: any) => c.x >= 55),
    "old map leaked across level change",
  );
  const up: any = await t.call("act", {
    sessionId: sid,
    action: "climb",
    direction: "up",
  });
  t.assert(
    up.observation.location.id === r.observation.location.id,
    "wrong return level",
  );
  t.assert(
    up.observation.world.some(
      (c: any) => c.x === 64 && c.y === 3 && c.terrain.type === "stairsDown",
    ),
    "stairs not remembered",
  );
});

test("locked door attempt has structured outcome and actual turn cost", async (t) => {
  const sid = await newWorld(t, {
    seed: 24,
    role: "valkyrie",
    race: "dwarf",
    align: "lawful",
  });
  for (let i = 0; i < 8; i++)
    await t.call("act", { sessionId: sid, action: "move", direction: "east" });
  const r: any = await t.call("act", {
    sessionId: sid,
    action: "open",
    target: { direction: "east" },
  });
  t.assert(
    r.outcome.status === "blocked" && r.outcome.reason === "lockedDoor",
    "not a locked door",
  );
  t.assert(
    r.outcome.turnsElapsed === 0,
    "this unsuccessful opening does not consume a NetHack turn",
  );
  t.assert(
    r.observation.world.some(
      (c: any) => c.x === 45 && c.y === 14 && c.terrain.type === "closedDoor",
    ),
    "locked door changed terrain",
  );
});

test("kick south is one intent, no menus or letters", async (t) => {
  const sid = await newWorld(t);
  const r: any = await t.call("act", {
    sessionId: sid,
    action: "kick",
    target: { direction: "south" },
  });
  t.assert(
    r.decision === null || r.decision.kind !== "choice",
    "kick leaked a raw choice",
  );
  t.assert(
    r.outcome.effects.includes("kicked"),
    `kick effect missing: ${JSON.stringify(r.outcome.effects)}`,
  );
});

test("self-directed effect uses target self; invalid targets fail early", async (t) => {
  const sid = await newWorld(t);
  const bad: any = await t.call("act", {
    sessionId: sid,
    action: "zap",
    item: "wand of sleep",
    target: "up",
  });
  t.assert(
    bad.outcome.status === "blocked" && bad.outcome.reason === "invalidTarget",
    `bad target: ${JSON.stringify(bad.outcome)}`,
  );
  const turn0: any = await t.call("get_state", { sessionId: sid });
  const zap: any = await t.call("act", {
    sessionId: sid,
    action: "zap",
    item: "wand of sleep",
    target: "self",
  });
  t.assert(
    zap.outcome.action === "zap",
    `self zap became ${zap.outcome.action}`,
  );
  const done = await settle(t, sid, zap);
  t.assert(
    done.observation.you.x === turn0.observation.you.x &&
      done.observation.you.y === turn0.observation.you.y,
    "self zap moved",
  );
});

test("eat lists inventory and here food without a turn; eat by name", async (t) => {
  const sid = await newWorld(t);
  const t0: any = await t.call("get_state", { sessionId: sid });
  const r: any = await t.call("act", { sessionId: sid, action: "eat" });
  t.assert(
    r.outcome.status === "needsChoice" && r.decision?.kind === "item",
    `eat listing: ${r.outcome.status}`,
  );
  const t1: any = await t.call("get_state", { sessionId: sid });
  t.assert(
    t1.observation.turn === t0.observation.turn,
    "listing consumed a turn",
  );
  const ate: any = await t.call("act", {
    sessionId: sid,
    replyTo: r.decision.id,
    item: "apples",
  });
  t.assert(
    ate.outcome.status === "completed",
    `eat by name: ${ate.outcome.status}`,
  );
  t.assert(
    ate.outcome.effects.includes("consumedItem") ||
      ate.outcome.turnsElapsed > 0,
    "eating did nothing",
  );
});

test("two matches need selection; miss and stale refs consume nothing", async (t) => {
  const sid = await newWorld(t);
  const t0: any = await t.call("get_state", { sessionId: sid });
  const amb: any = await t.call("act", {
    sessionId: sid,
    action: "drink",
    item: "healing",
  });
  t.assert(
    amb.outcome.status === "needsChoice" &&
      (amb.decision?.options?.length ?? 0) >= 2,
    "ambiguity not offered",
  );
  const miss: any = await t.call("act", {
    sessionId: sid,
    action: "drink",
    item: "motor oil",
  });
  t.assert(
    miss.outcome.reason === "noMatch" &&
      miss.observation.turn === t0.observation.turn,
    "miss consumed a turn",
  );
  const inv: any = await t.call("act", { sessionId: sid, action: "inventory" });
  const slot = (inv.observation.inventory as any[])[0];
  const drop: any = await t.call("act", {
    sessionId: sid,
    action: "drop",
    item: { id: slot.id },
  });
  t.assert(drop.outcome.status === "completed", `drop: ${drop.outcome.status}`);
  const stale: any = await t.call("act", {
    sessionId: sid,
    action: "wield",
    item: { id: slot.id },
  });
  t.assert(
    stale.outcome.reason === "staleReference" ||
      stale.outcome.reason === "noMatch",
    `stale rebind: ${stale.outcome.reason}`,
  );
});

test("dangerous warning becomes typed confirmation; decline does not restart", async (t) => {
  const sid = await newWorld(t);
  const t0: any = await t.call("get_state", { sessionId: sid });
  const p: any = await t.call("act", { sessionId: sid, action: "pray" });
  t.assert(p.decision?.kind === "confirmation", `prayer: ${p.decision?.kind}`);
  const no: any = await t.call("act", {
    sessionId: sid,
    replyTo: p.decision.id,
    confirm: false,
  });
  t.assert(no.decision == null, "declined prayer asked again");
  t.assert(
    no.observation.turn === t0.observation.turn,
    "decline restarted the prayer",
  );
});

test("invalid decision answers preserve prompt and state", async (t) => {
  const sid = await newWorld(t);
  const p: any = await t.call("act", { sessionId: sid, action: "pray" });
  const bad: any = await t.call("act", {
    sessionId: sid,
    replyTo: p.decision.id,
    choose: 3,
  });
  t.assert(
    bad.outcome.reason === "invalidAnswer",
    `wrong shape: ${bad.outcome.reason}`,
  );
  const done: any = await t.call("act", {
    sessionId: sid,
    replyTo: p.decision.id,
    cancel: true,
  });
  t.assert(done.outcome.status === "cancelled", "standing offer died");
});

test("retrying a timed-out prayer does not pray twice", async (t) => {
  const sid = await newWorld(t);
  const a: any = await t.call("act", {
    sessionId: sid,
    action: "pray",
    requestId: "pray-1",
  });
  const b: any = await t.call("act", {
    sessionId: sid,
    action: "pray",
    requestId: "pray-1",
  });
  t.assert(JSON.stringify(a) === JSON.stringify(b), "retry executed twice");
});

test("resume restores a resting full observation", async (t) => {
  const sid = await newWorld(t);
  const live: any = await t.call("get_state", { sessionId: sid });
  const back: any = await t.call("resume", { sessionId: sid });
  t.assert(
    JSON.stringify(back.observation) === JSON.stringify(live.observation),
    "resume observation mismatch",
  );
});

test("a read does not prevent the next action from returning its turn update", async (t) => {
  const sid = await newWorld(t);
  await t.call("get_state", { sessionId: sid });
  const r: any = await t.call("act", { sessionId: sid, action: "wait" });
  t.assert(
    r.events.some((e: any) => e.type === "felt" && e.sense === "turn"),
    "no turn update after independent read",
  );
});

test("a real death cause and final perception survive cold replay", async (t) => {
  const sid = await newWorld(t, {
    seed: 42,
    role: "valkyrie",
    race: "dwarf",
    align: "lawful",
  });
  let r: any;
  for (let i = 0; i < 20; i++) {
    r = await t.call("act", { sessionId: sid, action: "pray" });
    t.assert(
      r.decision?.kind === "confirmation",
      "prayer did not request consent",
    );
    r = await t.call("act", {
      sessionId: sid,
      replyTo: r.decision.id,
      confirm: true,
    });
    if (r.ended) break;
  }
  t.assert(
    r.ended && r.end?.kind === "death" && r.end.cause.startsWith("killed by "),
    "no structured death in bounded lethal scenario",
  );
  t.assert(
    r.observation.vitals.health === 0 && r.decision === null,
    "invalid terminal perception",
  );
  const back: any = await t.call("resume", { sessionId: sid });
  t.assert(
    JSON.stringify(back.end) === JSON.stringify(r.end),
    "terminal result changed during replay",
  );
  t.assert(
    JSON.stringify(back.observation) === JSON.stringify(r.observation),
    "post-game disclosure changed final gameplay perception",
  );
});

test("a multi-turn meal stops at a declined warning and does not restart on resume", async (t) => {
  const sid = await newWorld(t, {
    seed: 42,
    role: "tourist",
    race: "human",
    align: "neutral",
  });
  const start: any = await t.call("get_state", { sessionId: sid });
  const ration = start.observation.inventory.find((i: any) =>
    i.label.includes("food ration"),
  );
  t.assert(ration?.quantity > 2, "missing meal fixture");
  const first: any = await t.call("act", {
    sessionId: sid,
    action: "eat",
    item: { id: ration.id },
  });
  t.assert(
    first.outcome.status === "completed" && first.outcome.turnsElapsed === 6,
    "meal did not complete at its bounded boundary",
  );
  const warning: any = await t.call("act", {
    sessionId: sid,
    action: "eat",
    item: { id: ration.id },
  });
  t.assert(
    warning.decision?.kind === "confirmation",
    "no typed continue-eating warning",
  );
  t.assert(
    warning.observation.inventory.some((i: any) =>
      i.label.includes("partly eaten food ration"),
    ),
    "decision observation is stale",
  );
  const stop: any = await t.call("act", {
    sessionId: sid,
    replyTo: warning.decision.id,
    confirm: false,
  });
  t.assert(
    stop.outcome.status === "interrupted" &&
      stop.outcome.turnsElapsed === 2 &&
      stop.decision === null,
    "meal did not stop coherently",
  );
  const back: any = await t.call("resume", { sessionId: sid });
  t.assert(
    back.decision === null &&
      JSON.stringify(back.observation) === JSON.stringify(stop.observation),
    "resume restarted or changed the interrupted meal",
  );
});
