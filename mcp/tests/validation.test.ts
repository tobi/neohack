import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { TestBridge, testDirectory } from "./bridge-harness";
import { dispatch, forwardToolRequest } from "../src/server";
const file = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8") : null;

async function fixture(
  fn: (
    b: TestBridge,
    g: any,
    reject: (args: any, raw?: boolean) => Promise<void>,
  ) => Promise<void>,
) {
  const b = new TestBridge(testDirectory("validation"));
  try {
    const g = await b.newGame();
    const reject = async (args: any, raw = false) => {
      const before = await b.call("get_state", { sessionId: g.sessionId });
      const prefix = `${b.sessions}/${g.sessionId}/`;
      const names = [
        "input.log.jsonl",
        "requests.seen.jsonl",
        "perceptions.jsonl",
      ];
      const bytes = names.map((n) => file(prefix + n));
      const r = raw
        ? await b.callRaw(args)
        : await b.call("act", { sessionId: g.sessionId, ...args });
      expect(r.error).toBeDefined();
      expect(r.outcome.status).toBe("blocked");
      const after = await b.call("get_state", { sessionId: g.sessionId });
      expect(after.observation).toEqual(before.observation);
      expect(after.revision).toBe(before.revision);
      expect(after.decision).toEqual(before.decision);
      expect(names.map((n) => file(prefix + n))).toEqual(bytes);
      if (r.observation) expect(r.decision).toEqual(before.decision);
    };
    await fn(b, g, reject);
  } finally {
    await b.close();
  }
}

test("invalid shapes are rejected before time, input, receipts or standing offers change", () =>
  fixture(async (b, g, reject) => {
    for (const args of [
      { action: "wait", direction: "east" },
      { action: "wait", confirm: true },
      { action: "wait", quantity: 4 },
      { action: "move", direction: "up" },
      { action: "move", direction: 3 },
      { action: "climb", direction: "north" },
      { action: "inspect", target: 7 },
      { action: "inspect", target: null },
      { action: "inspect", target: { direction: "north" } },
      { action: "open", target: { direction: "up" } },
      { action: "zap", target: { direction: "south", entity: "self" } },
      { action: "eat", item: null },
      { action: "eat", item: "" },
      { action: "eat", item: { id: "item-36", quantity: 2 } },
      { action: "apply", item: "key", target: { direction: "north" } },
      { action: "wait", direciton: "north" },
      { action: "wait", expectedRevision: -1, requestId: "reusable" },
      { action: "wait", expectedRevision: null },
      { action: "wait", expectedRevision: "0" },
      { action: "wait", expectedRevision: 0.5 },
      { action: "wait", expectedRevision: 2 ** 53 },
      { action: "wait", requestId: null },
      { action: "wait", requestId: 42 },
      { action: "wait", requestId: "" },
      { action: "wait", requestId: "x".repeat(129) },
      { action: "wait\0move" },
      { action: "move", direction: "north\nsouth" },
    ])
      await reject(args);
    const offer = await b.call("act", {
      sessionId: g.sessionId,
      action: "eat",
    });
    await reject({ action: "cast" });
    for (const answer of [
      { item: "ration", cancel: true },
      { item: "ration", confirm: true },
      { cancel: false },
      { confirm: "false" },
      { choose: [0, "1"] },
      { choose: [] },
      { choose: [0, 0] },
      { choose: Array.from({ length: 65 }, (_, i) => i) },
      { text: "x".repeat(129) },
      { text: "escape\u001b" },
      { action: "eat", item: "ration" },
    ])
      await reject({ replyTo: offer.decision.id, ...answer });
    await b.call("act", {
      sessionId: g.sessionId,
      replyTo: offer.decision.id,
      cancel: true,
    });
    const good = await b.call("act", {
      sessionId: g.sessionId,
      action: "wait",
      requestId: "reusable",
    });
    expect(good.error).toBeUndefined();
    expect(good.outcome.turnsElapsed).toBe(1);
  }));

test("native duplicate/escaped fields and unrepresentable strings cannot select a different intent", () =>
  fixture(async (b, g, reject) => {
    const prefix = `{"tool":"act","sessionId":${JSON.stringify(g.sessionId)},`;
    for (const rest of [
      '"action":"wait","action":"move","direction":"east"}',
      '"action":"open","target":{"direction":"north","direction":"south"}}',
      '"action":"open","target":{"direc\\u0074ion":"north"}}',
      '"\\u0061ction":"wait"}',
      '"action":"wait\\u0000move"}',
      '"action":"wait","requestId":"bad\\ud800"}',
    ])
      await reject(prefix + rest, true);
    const escaped = await b.callRaw(
      prefix + '"action":"wait","requestId":"unicode-\\ud83d\\ude80"}',
    );
    expect(escaped.error).toBeUndefined();
    expect(
      await b.call("act", {
        sessionId: g.sessionId,
        action: "wait",
        requestId: "unicode-🚀",
      }),
    ).toEqual(escaped);
  }));

test("invalid creation arguments do not create a directory or choose a random identity", () =>
  fixture(async (b, g) => {
    const before = readdirSync(b.sessions).sort();
    for (const args of [
      { seed: null },
      { seed: "42" },
      { seed: 0.1 },
      { seed: 2 ** 53 },
      { role: 1 },
      { name: null },
      { name: "x".repeat(32) },
      { name: "x\ny" },
      { sessionId: 1 },
      { unknown: true },
    ]) {
      const r = await b.call("new_game", args);
      expect(r.error).toBeDefined();
      expect(readdirSync(b.sessions).sort()).toEqual(before);
    }
  }));

test("MCP preserves unknown fields for core rejection and cannot override tool framing", async () => {
  expect(
    forwardToolRequest("act", { action: "wait", direciton: "north" }),
  ).toEqual({ tool: "act", action: "wait", direciton: "north" });
  expect(() => forwardToolRequest("act", { tool: "new_game" })).toThrow(
    "reserved",
  );
  const wrongName: any = await dispatch({
    id: 1,
    method: "tools/call",
    params: { name: ["new_game"], arguments: {} },
  });
  expect(wrongName.error.code).toBe(-32602);
  for (const args of [null, [], 1, "wait"]) {
    const r: any = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "new_game", arguments: args },
    });
    expect(r.error.message).toContain("arguments must be an object");
  }
});
