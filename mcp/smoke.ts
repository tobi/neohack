// Scripted smoke for neonethack-mcp v3 (world API): speaks MCP over
// stdio, steps into a world, explores ~60 deeds off EVENTS, answers typed
// decisions, leaves, re-enters from the remembered deeds, and checks the
// perceived world matches. Nothing terminal-like may leak.
import { spawn } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;
const SERVER = new URL("./src/server.ts", import.meta.url).pathname;

const proc = spawn(["bun", SERVER], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    SESSIONS_DIR: "/tmp/mcpsmoke-sessions",
    ENGINE_CMD: `${ROOT}/upstream/playground/nethack`,
    PLAYGROUND_TEMPLATE: `${ROOT}/upstream/playground`,
  },
});

let seq = 0;
const waiters = new Map<number, (v: any) => void>();
let outBuf = "";
const reader = proc.stdout.getReader();
const pump = (async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    outBuf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, idx);
      outBuf = outBuf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number" && waiters.has(m.id)) {
          waiters.get(m.id)!(m);
          waiters.delete(m.id);
        }
      } catch {
        /* ignore */
      }
    }
  }
})();

function rpc(method: string, params: unknown = {}): Promise<any> {
  const id = ++seq;
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const call = (name: string, args: unknown) =>
  rpc("tools/call", { name, arguments: args }).then((r) => {
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return JSON.parse(r.result.content[0].text);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(500);
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });

// Step in: who-you-are is named in words. Nothing of the machinery may leak.
let st: any = await call("new_game", {
  seed: 7, name: "smokebot",
  role: "healer", race: "elf", gender: "female", align: "neutral",
});
const sid = st.sessionId as string;
console.log("session:", sid, "turn:", st.observation.turn, "you:", JSON.stringify(st.observation.you));
const leaked = ["cells", "messages", "pending", "menus", "choices", "commands", "glyph", "\"key\"", "letter", "prompt"]
  .filter((k) => JSON.stringify(st).includes(`"${k}"`));
if (leaked.length) throw new Error(`machinery leaked into new_game: ${leaked.join(",")}`);
if (st.outcome.status !== "completed") throw new Error(`bad new_game status: ${st.outcome.status}`);
const o = st.observation;
if (typeof o.turn !== "number" || !(o.turn >= 1)) throw new Error(`bad turn: ${o.turn}`);
if (!o.vitals?.health || !o.vitals?.maxHealth) throw new Error("no health vitals");
if (!Array.isArray(o.inventory) || o.inventory.length < 8) throw new Error("no starting inventory");
if (!Array.isArray(o.world) || !o.world.length) throw new Error("no perceived world");
const kinds = new Set(o.world.map((c: any) => (c.occupant ? (c.occupant.kind === "self" ? "you" : c.occupant.kind) : c.objects ? "object" : "terrain")));
console.log("health:", o.vitals.health, "items:", o.inventory.length, "cells:", o.world.length);
const turns0 = o.turn;

async function settle(d: any): Promise<any> {
  // Answer whatever the world waits on until it rests (bounded).
  for (let i = 0; i < 6 && d.outcome?.status === "needsChoice" && d.decision && !d.ended; i++) {
    const dec = d.decision;
    let ans: any = { replyTo: dec.id, cancel: true };
    if (dec.kind === "confirmation") ans = { replyTo: dec.id, confirm: false };
    d = await call("act", { sessionId: sid, ...ans });
  }
  return d;
}

const dirs = ["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"];
let d: any = st;
let acts = 0, saw = 0, felt = 0, heard = 0, shown = 0;
for (let i = 0; i < 60 && !d.ended; i++) {
  d = await call("act", { sessionId: sid, action: "move", direction: dirs[i % dirs.length] });
  d = await settle(d);
  acts++;
  if (!Array.isArray(d.events)) throw new Error(`act #${acts} has no events array`);
  for (const e of d.events) {
    if (e.type === "saw") saw++;
    else if (e.type === "felt") felt++;
    else if (e.type === "heard") heard++;
    else if (e.type === "shown") shown++;
    else throw new Error(`unknown event: ${e.type}`);
  }
  if (d.observation == null || d.outcome == null) throw new Error(`act #${acts} broke the envelope`);
}
const live: any = await call("get_state", { sessionId: sid });
console.log(`deeds: ${acts}, saw: ${saw}, felt: ${felt}, heard: ${heard}, shown: ${shown}, turns: ${turns0} -> ${live.observation.turn}, ended: ${live.ended}`);
if (live.ended) {
  console.log("SMOKE: explorer died mid-walk (world worked, wanderer didn't survive)");
  proc.kill();
  process.exit(2);
}

// Re-enter: rebuilt world must match the one left behind.
const snap = (s: any) => JSON.stringify({ w: s.observation.world, v: s.observation.vitals, i: s.observation.inventory, h: s.observation.heard, t: s.observation.turn, y: s.observation.you });
const before = snap(live);
const r: any = await call("resume", { sessionId: sid });
const same = snap(r) === before;
console.log("re-enter turn:", r.observation.turn, "identical perceived world:", same);
await call("end_session", { sessionId: sid });

// Interruptions: the world asks typed questions; the explorer answers.
const st2: any = await call("new_game", {
  seed: 7, name: "secondbot",
  role: "healer", race: "elf", gender: "female", align: "neutral",
});
const sid2 = st2.sessionId as string;
// eat with no item offers food without spending a turn.
let d2: any = await call("act", { sessionId: sid2, action: "eat" });
if (d2.outcome.status !== "needsChoice" || d2.decision?.kind !== "item" || !Array.isArray(d2.decision.options)) {
  throw new Error(`eat did not offer food: ${JSON.stringify(d2.outcome)}`);
}
console.log("eat options:", d2.decision.options.map((x: any) => x.label).join(" | ").slice(0, 120));
// Eat the first offered food by ref.
const first = d2.decision.options[0];
d2 = await call("act", { sessionId: sid2, replyTo: d2.decision.id, item: { id: first.id } });
if (!["completed", "needsChoice"].includes(d2.outcome.status)) throw new Error(`eat by ref failed: ${d2.outcome.status}`);
d2 = await awaitSettle2(d2);
console.log("eat by ref:", d2.outcome.status, JSON.stringify(d2.outcome.effects));
async function awaitSettle2(dd: any): Promise<any> {
  for (let i = 0; i < 6 && dd.outcome?.status === "needsChoice" && dd.decision; i++) {
    const dec = dd.decision;
    const ans: any = dec.kind === "confirmation" ? { replyTo: dec.id, confirm: false } : { replyTo: dec.id, cancel: true };
    dd = await call("act", { sessionId: sid2, ...ans });
  }
  return dd;
}
// Prayer raises a confirmation; declining never restarts it.
d2 = await call("act", { sessionId: sid2, action: "pray" });
if (d2.decision?.kind !== "confirmation") throw new Error(`prayer is not a confirmation: ${JSON.stringify(d2.decision)}`);
d2 = await call("act", { sessionId: sid2, replyTo: d2.decision.id, confirm: false });
if (d2.decision) throw new Error("declined prayer asked again");
console.log("prayer declined:", d2.outcome.status);
// A self kick is rejected before the world is touched.
d2 = await call("act", { sessionId: sid2, action: "kick", target: "self" });
if (d2.outcome.reason !== "invalidTarget") throw new Error(`kick self not rejected: ${JSON.stringify(d2.outcome)}`);
console.log("kick self rejected:", d2.outcome.reason);
await call("end_session", { sessionId: sid2 });
console.log("interruptions: item/confirmation/invalidTarget OK");

const ok = live.observation.turn - turns0 >= 10 && same;
console.log(ok ? "SMOKE: PASS" : "SMOKE: FAIL");
proc.kill();
process.exit(ok ? 0 : 1);
