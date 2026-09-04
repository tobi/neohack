import { expect, test } from "bun:test";
import { parseWireJson, MAX_WIRE_BYTES } from "../src/wire-json";
import { handlePost } from "../src/http";

test("transport rejects duplicate fields before JSON parsing can discard an intent", () => {
  for (const text of [
    '{"action":"wait","action":"move"}',
    '{"a":{"id":1,"id":2}}',
    '[{"x":0,"\\u0078":1}]',
    '{"__proto__":1,"__proto__":2}',
  ])
    expect(() => parseWireJson(text)).toThrow("Duplicate");
  expect(() => parseWireJson(" ".repeat(MAX_WIRE_BYTES) + "{}")).toThrow(
    "too large",
  );
  expect(() => parseWireJson("[".repeat(66) + "0" + "]".repeat(66))).toThrow(
    "nesting",
  );
});

test("wire validation preserves valid JSON including quoted keys, UTF-8 and surrogate pairs", () => {
  const values = [
    null,
    42,
    1e20,
    true,
    [],
    {},
    ["comma,", "bracket]", 'quote"', "backslash\\", "🚀"],
    { 'quoted"key': { "\n": false }, x: [{ x: 0 }] },
    { __proto__: null, constructor: 1 },
  ];
  for (const value of values)
    expect(parseWireJson(JSON.stringify(value))).toEqual(value);
  expect(parseWireJson('{"\\ud83d\\ude80":"ok"}')).toEqual({ "🚀": "ok" });
});

test("HTTP rejects ambiguous JSON and invalid UTF-8 without dispatching a tool", async () => {
  for (const body of [
    '{"method":"initialize","method":"ping"}',
    '{"method":"initialize","params":{"arguments":{"action":"wait","action":"move"}}}',
    new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
  ]) {
    const r = await handlePost(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe(-32700);
  }
});
