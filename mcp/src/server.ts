// neonethack-mcp: an MCP server over stdio that is a way to view another
// world being explored. You are the explorer: you look (get_state), you
// do (act), the world interrupts with typed decisions, and everything
// you perceive arrives as structured observations and events.
//
// All world semantics live in libneonethack (lib/explorer.c); this
// process only transports tool calls to the cli/nhxcli bridge child
// (see mcp/src/core.ts). No keys, no menus, no camera, no unseen things.
//
// Tools (see API_DESING.md):
//   new_game {seed?, name?, role?, race?, gender?, align?}
//   get_state {sessionId}
//   act {sessionId, action?, direction?, target?, item?, replyTo?,
//        confirm?|choose?|text?|cancel?, expectedRevision?, requestId?}
//   resume {sessionId}
//   end_session {sessionId}
import { callCore } from "./core";

// Forwarded verbatim; the core validates shapes before any engine input.
const FORWARD = [
  "sessionId",
  "action",
  "direction",
  "target",
  "item",
  "replyTo",
  "confirm",
  "choose",
  "text",
  "cancel",
  "expectedRevision",
  "requestId",
  "seed",
  "name",
  "role",
  "race",
  "gender",
  "align",
] as const;

function pick(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { tool };
  for (const k of FORWARD) {
    if (args[k] !== undefined) out[k] = args[k];
  }
  return out;
}

export const TOOLS = [
  {
    name: "new_game",
    description:
      "Step into a new world as an explorer. Returns the full observation: turn, location, you {x,y}, vitals, inventory with opaque item refs, the perceived world, recent heard sayings, and events. Identity is named in words (role, race, gender, align); anything omitted is chosen by the world. Pass seed for a replayable world.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "integer", description: "Fixed fate for a replayable world; omit for a fresh one." },
        name: { type: "string", description: "Your name." },
        role: { type: "string", description: "Your calling: archeologist, barbarian, caveman, healer, knight, monk, priest, rogue, ranger, samurai, tourist, valkyrie, wizard." },
        race: { type: "string", description: "Your folk: human, elf, dwarf, gnome, orc." },
        gender: { type: "string", description: "male or female." },
        align: { type: "string", description: "Your heart: lawful, neutral, chaotic." },
      },
    },
  },
  {
    name: "get_state",
    description:
      "Look closely at the world without doing anything: the full observation, same shape as new_game. Costs no turn and no revision.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "act",
    description:
      "Do something as the explorer, or answer a standing decision. Named actions: move {direction}, wait, climb {direction: up|down}, inspect {target: self|here}, inventory, search, kick/open/close {target: {direction}}, pickup {item?}, eat/drink/wield/equip/wear/remove/read/apply/drop/zap {item?}, pray. Targets: \"self\", \"here\", {direction}, never letters. Items: names or opaque {id} refs from a listing; omit item to be offered candidates (costs no turn). Answers: {replyTo, item:{id}} for item offers, {replyTo, target} for targets, {replyTo, confirm} for confirmations, {replyTo, choose} for choices, {replyTo, text} for words, {replyTo, cancel} to turn away. Every reply returns the full observation plus the outcome (status, turnsElapsed, positionChanged, effects) and the next decision, if any. expectedRevision guards against stale reads; requestId makes retries safe.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        action: { type: "string", description: "What to do: move, wait, climb, inspect, inventory, search, kick, open, close, pickup, eat, drink, wield, equip, wear, remove, read, apply, drop, zap, pray." },
        direction: { type: "string", description: "Compass direction (or up/down): north, south, east, west, northeast, northwest, southeast, southwest, up, down." },
        target: { description: "Where to aim: \"self\", \"here\", or {direction: ...}." },
        item: { description: "What to use: a perceived name, or {id} from a listing." },
        replyTo: { type: "string", description: "The standing decision id being answered." },
        confirm: { type: "boolean", description: "Answer a confirmation decision." },
        choose: { description: "Answer a choice decision: option id, or array of ids." },
        text: { type: "string", description: "Answer a text decision with words." },
        cancel: { type: "boolean", description: "Turn away from the standing decision." },
        expectedRevision: { type: "integer", description: "Fail with staleRevision when the world moved." },
        requestId: { type: "string", description: "Client-generated id: same id+payload replays the original result instead of acting twice." },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "resume",
    description:
      "Return to a world you left: rebuilds it exactly as it was from the remembered deeds, including the standing decision. Returns the full observation.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "end_session",
    description: "Leave the world (it is kept safe and the way closes).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
];

export async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case "new_game":
    case "get_state":
    case "act":
    case "resume":
    case "end_session":
      return callCore(pick(name, args));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// One JSON-RPC message in, zero or one reply out. Shared by the stdio
// transport (below) and the web transport (http.ts).
export async function dispatch(raw: unknown): Promise<Record<string, unknown> | null> {
  const msg = raw as { id?: unknown; method?: string; params?: Record<string, unknown> };
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return null;
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    if (msg.method === "initialize") {
      return ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "neonethack-mcp", version: "0.4.0" },
      });
    } else if (msg.method === "ping") {
      return ok({});
    } else if (msg.method === "tools/list") {
      return ok({ tools: TOOLS });
    } else if (msg.method === "tools/call") {
      const name = String(params["name"] ?? "");
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      const out = await callTool(name, args);
      return ok({ content: [{ type: "text", text: JSON.stringify(out) }] });
    } else if (typeof id === "undefined" || id === null) {
      // Notification (e.g. notifications/initialized): no reply.
      return null;
    } else {
      return fail(-32601, `method not found: ${msg.method}`);
    }
  } catch (err) {
    if (typeof id !== "undefined" && id !== null) {
      return fail(-32000, err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

async function handleMessage(raw: unknown): Promise<void> {
  const r = await dispatch(raw);
  if (r) process.stdout.write(JSON.stringify(r) + "\n");
}

async function main(): Promise<void> {
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        await handleMessage(JSON.parse(line));
      } catch {
        /* unparseable line: ignore */
      }
    }
  }
}

if (import.meta.main) await main();
