// Acceptance tests: API_DESING.md section 12, one test per contract
// clause. Helpers at the bottom keep scenarios deterministic. Scenario
// clauses without a staged scenario are explicit SKIPs, never vacuous passes.
// Additional real-engine regressions live in mcp/tests/core-contract.test.ts.
import { test, type TestCtx } from "../accept";

async function newWorld(t: TestCtx, identity = {}) {
  const f: any = await t.call("new_game", {
    seed: 7, name: "accept", role: "healer", race: "elf", gender: "female", align: "neutral",
    ...identity,
  });
  return f.sessionId as string;
}

async function settle(t: TestCtx, sid: string, d: any): Promise<any> {
  for (let i = 0; i < 6 && d.outcome?.status === "needsChoice" && d.decision && !d.ended; i++) {
    const dec = d.decision;
    const ans: any = dec.kind === "confirmation" ? { replyTo: dec.id, confirm: false } : { replyTo: dec.id, cancel: true };
    d = await t.call("act", { sessionId: sid, ...ans });
  }
  return d;
}

test("100 actions from replies alone match a final snapshot", async (t) => {
  const sid = await newWorld(t);
  const dirs = ["north", "south", "east", "west"];
  let acc: any = await t.call("get_state", { sessionId: sid });
  for (let i = 0; i < 100 && !acc.ended; i++) {
    acc = await t.call("act", { sessionId: sid, action: "move", direction: dirs[i % dirs.length] });
    acc = await settle(t, sid, acc);
  }
  const live: any = await t.call("get_state", { sessionId: sid });
  t.assert(JSON.stringify(stripForEquiv(live)) === JSON.stringify(stripForEquiv(acc)),
    "accumulated perception differs from independent snapshot");
});

function stripForEquiv(o: any) {
  return { observation: o.observation, decision: o.decision };
}

test.skip("walk and exchange places with a pet; self never an enemy",  async (t) => {
  const sid = await newWorld(t);
  const s: any = await t.call("get_state", { sessionId: sid });
  t.assert(s.observation.world.some((c: any) => c.occupant?.kind === "self"), "no self occupant");
  t.assert(!s.observation.world.some((c: any) => c.occupant?.kind === "creature" && c.occupant?.ref === "self"), "self as creature");
});

test.skip("stairs: inspect here, descend, map replaced, stairs remembered",  async (t) => {
  const sid = await newWorld(t);
  const s: any = await t.call("act", { sessionId: sid, action: "inspect", target: "here" });
  t.assert(s.outcome.status === "completed", `inspect here: ${s.outcome.status}`);
});

test.skip("locked door attempt has structured outcome and turn cost",  async (t) => {
  const sid = await newWorld(t);
  void sid;
});

test("kick south is one intent, no menus or letters", async (t) => {
  const sid = await newWorld(t);
  const r: any = await t.call("act", { sessionId: sid, action: "kick", target: { direction: "south" } });
  t.assert(r.decision === null || r.decision.kind !== "choice", "kick leaked a raw choice");
  t.assert(r.outcome.effects.includes("kicked"), `kick effect missing: ${JSON.stringify(r.outcome.effects)}`);
});

test("self-directed effect uses target self; invalid targets fail early", async (t) => {
  const sid = await newWorld(t);
  const bad: any = await t.call("act", { sessionId: sid, action: "zap", item: "wand of sleep", target: "up" });
  t.assert(bad.outcome.status === "blocked" && bad.outcome.reason === "invalidTarget", `bad target: ${JSON.stringify(bad.outcome)}`);
  const turn0: any = await t.call("get_state", { sessionId: sid });
  const zap: any = await t.call("act", { sessionId: sid, action: "zap", item: "wand of sleep", target: "self" });
  t.assert(zap.outcome.action === "zap", `self zap became ${zap.outcome.action}`);
  const done = await settle(t, sid, zap);
  t.assert(done.observation.you.x === turn0.observation.you.x && done.observation.you.y === turn0.observation.you.y, "self zap moved");
});

test("eat lists inventory and here food without a turn; eat by name", async (t) => {
  const sid = await newWorld(t);
  const t0: any = await t.call("get_state", { sessionId: sid });
  const r: any = await t.call("act", { sessionId: sid, action: "eat" });
  t.assert(r.outcome.status === "needsChoice" && r.decision?.kind === "item", `eat listing: ${r.outcome.status}`);
  const t1: any = await t.call("get_state", { sessionId: sid });
  t.assert(t1.observation.turn === t0.observation.turn, "listing consumed a turn");
  const ate: any = await t.call("act", { sessionId: sid, replyTo: r.decision.id, item: "apples" });
  t.assert(ate.outcome.status === "completed", `eat by name: ${ate.outcome.status}`);
  t.assert(ate.outcome.effects.includes("consumedItem") || ate.outcome.turnsElapsed > 0, "eating did nothing");
});

test("two matches need selection; miss and stale refs consume nothing", async (t) => {
  const sid = await newWorld(t);
  const t0: any = await t.call("get_state", { sessionId: sid });
  const amb: any = await t.call("act", { sessionId: sid, action: "drink", item: "healing" });
  t.assert(amb.outcome.status === "needsChoice" && (amb.decision?.options?.length ?? 0) >= 2, "ambiguity not offered");
  const miss: any = await t.call("act", { sessionId: sid, action: "drink", item: "motor oil" });
  t.assert(miss.outcome.reason === "noMatch" && miss.observation.turn === t0.observation.turn, "miss consumed a turn");
  const inv: any = await t.call("act", { sessionId: sid, action: "inventory" });
  const slot = (inv.observation.inventory as any[])[0];
  const drop: any = await t.call("act", { sessionId: sid, action: "drop", item: { id: slot.id } });
  t.assert(drop.outcome.status === "completed", `drop: ${drop.outcome.status}`);
  const stale: any = await t.call("act", { sessionId: sid, action: "wield", item: { id: slot.id } });
  t.assert(stale.outcome.reason === "staleReference" || stale.outcome.reason === "noMatch", `stale rebind: ${stale.outcome.reason}`);
});

test("dangerous warning becomes typed confirmation; decline does not restart", async (t) => {
  const sid = await newWorld(t);
  const t0: any = await t.call("get_state", { sessionId: sid });
  const p: any = await t.call("act", { sessionId: sid, action: "pray" });
  t.assert(p.decision?.kind === "confirmation", `prayer: ${p.decision?.kind}`);
  const no: any = await t.call("act", { sessionId: sid, replyTo: p.decision.id, confirm: false });
  t.assert(no.decision == null, "declined prayer asked again");
  t.assert(no.observation.turn === t0.observation.turn, "decline restarted the prayer");
});

test("invalid decision answers preserve prompt and state", async (t) => {
  const sid = await newWorld(t);
  const p: any = await t.call("act", { sessionId: sid, action: "pray" });
  const bad: any = await t.call("act", { sessionId: sid, replyTo: p.decision.id, choose: 3 });
  t.assert(bad.outcome.reason === "invalidAnswer", `wrong shape: ${bad.outcome.reason}`);
  const done: any = await t.call("act", { sessionId: sid, replyTo: p.decision.id, cancel: true });
  t.assert(done.outcome.status === "cancelled", "standing offer died");
});

test("retrying a timed-out prayer does not pray twice", async (t) => {
  const sid = await newWorld(t);
  const a: any = await t.call("act", { sessionId: sid, action: "pray", requestId: "pray-1" });
  const b: any = await t.call("act", { sessionId: sid, action: "pray", requestId: "pray-1" });
  t.assert(JSON.stringify(a) === JSON.stringify(b), "retry executed twice");
});

test("resume restores a resting full observation",  async (t) => {
  const sid = await newWorld(t);
  const live: any = await t.call("get_state", { sessionId: sid });
  const back: any = await t.call("resume", { sessionId: sid });
  t.assert(JSON.stringify(back.observation) === JSON.stringify(live.observation), "resume observation mismatch");
});

test("a read does not prevent the next action from returning its turn update",  async (t) => {
  const sid = await newWorld(t);
  await t.call("get_state", { sessionId: sid });
  const r: any = await t.call("act", { sessionId: sid, action: "wait" });
  t.assert(r.events.some((e: any) => e.type === "felt" && e.sense === "turn"), "no turn update after independent read");
});

test.skip("death cause survives post-game lists; engine failure is not death",  async (t) => {
  const sid = await newWorld(t);
  void sid;
});

test.skip("multi-step actions terminate at bounded boundaries",  async (t) => {
  const sid = await newWorld(t);
  void sid;
});
