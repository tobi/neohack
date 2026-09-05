import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWebMcp } from "../dist/typescript/webmcp.js";
import { tools, toolMethods } from "../dist/mcp/tools.js";

test("WebMCP current registration, exact arguments, abort and cleanup", async () => {
  const registered = new Map(),
    sent = [];
  const context = {
    async registerTool(tool, { signal }) {
      registered.set(tool.name, tool);
      signal.addEventListener("abort", () => registered.delete(tool.name));
    },
  };
  const registration = await registerWebMcp(
    {
      async send(request) {
        sent.push(request);
        return {
          version: 1,
          error: {
            code: "invalidParams",
            message: "engine validates unknown arguments",
          },
        };
      },
    },
    context,
  );
  assert.equal(registration.toolCount, tools.length);
  for (const tool of tools) {
    const actual = registered.get(tool.name);
    assert.deepEqual(actual.inputSchema, tool.inputSchema);
    assert.equal(actual.description, tool.description);
    assert.equal(
      actual.annotations.readOnlyHint,
      tool.annotations.readOnlyHint,
    );
    const args = {
      extra: { untouched: [1, 2] },
      requestId: "same-id",
      expectedRevision: 9,
    };
    const result = await actual.execute(args);
    assert.deepEqual(sent.at(-1), {
      version: 1,
      method: toolMethods.get(tool.name),
      params: args,
    });
    assert.equal(result.isError, true);
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
    );
  }
  const callback = registered.values().next().value.execute;
  const cancelled = new AbortController();
  cancelled.abort();
  await callback({}, { signal: cancelled.signal });
  assert.equal(
    sent.length,
    tools.length,
    "aborted invocation never reaches transport",
  );
  registration.dispose();
  assert.equal(registered.size, 0);
  assert.equal((await callback({})).isError, true);
  assert.equal(sent.length, tools.length, "retired callbacks cannot submit");
});

test("WebMCP rolls back partial registration, supports unavailable browsers and reports uncertain transport", async () => {
  const names = new Set();
  await assert.rejects(
    registerWebMcp(
      {
        send() {
          throw Error("unused");
        },
      },
      {
        registerTool(tool) {
          if (names.size === 3) throw Error("registration rejected");
          names.add(tool.name);
        },
        unregisterTool(name) {
          names.delete(name);
        },
      },
    ),
    /registration rejected/,
  );
  assert.equal(names.size, 0);
  assert.equal(
    (
      await registerWebMcp({
        send() {
          throw Error("unused");
        },
      })
    ).supported,
    false,
  );
  let execute;
  const registration = await registerWebMcp(
    {
      send() {
        throw Error("lost receipt");
      },
    },
    {
      registerTool(tool) {
        execute = tool.execute;
      },
      unregisterTool() {},
    },
  );
  const failed = await execute({});
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /exact requestId and payload/);
  registration.dispose();
});
