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
    assert.deepEqual(result.content, []);
    assert.equal(result.structuredContent.error.code, "invalidParams");
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

test("real engine WebMCP deltas reconstruct perception and reduce movement payload", { timeout: 30000 }, async t => {
  const { fixture, identity } = await import('./native-fixture.mjs');
  const { CompactObservationReader } = await import('../dist/mcp/compact.js');
  const { transport } = await fixture(t);
  const registered = new Map(); let full;
  await registerWebMcp({ async send(request) { full = await transport.send(request); return full; } }, {
    registerTool(tool) { registered.set(tool.name, tool); },
  });
  const reader = new CompactObservationReader(); let state, bytes = 0, original = 0;
  const call = async (method, args) => {
    const result = await registered.get(method).execute(args);
    const materialized = reader.apply(result.structuredContent);
    const expected = structuredClone(full); if (method !== 'session_observe') delete expected.observation?.neighborhood;
    assert.deepEqual(materialized, expected);
    state = materialized;
    return result.structuredContent;
  };
  await call('session_create', identity);
  let firstArgs;
  for (let i = 0; i < 12; i++) {
    const args = {sessionId: state.sessionId, requestId: `compact-${i}`, expectedRevision: state.revision, direction: i % 2 ? 'west' : 'east'};
    firstArgs ??= args;
    const result = await call('game_move', args);
    assert.equal(result.update.kind, 'delta');
    assert.equal(result.observation.inventory, undefined);
    bytes += JSON.stringify(result).length;
    original += JSON.stringify(full).length * 2;
  }
  t.diagnostic(`12 moves: ${original} old duplicated JSON bytes -> ${bytes} compact bytes (${(100 * (1 - bytes/original)).toFixed(1)}% reduction)`);
  assert.ok(bytes < original * 0.25);
  const retry = await call('game_move', firstArgs);
  assert.equal(retry.update.kind, 'snapshot', 'historical receipts reset rather than misapply a newer map');
  assert.equal((await call('session_observe', {sessionId: state.sessionId})).update.kind, 'snapshot');
  assert.ok(state.observation.neighborhood);
  const next = await call('game_wait', {sessionId:state.sessionId,requestId:'after-full',expectedRevision:state.revision});
  assert.ok(next.update.remove.includes('neighborhood'), 'next delta removes stale action offers');
});

test('compact replacements clear vanished cells, occupants, empty lists and stale fields', async () => {
  const {CompactResponses, CompactObservationReader} = await import('../dist/mcp/compact.js');
  const compact = new CompactResponses(), reader = new CompactObservationReader();
  const initial = {version:1,sessionId:'a',revision:1,observation:{location:{id:'level'},inventory:[{id:'opaque'}],heard:['hello'],you:{x:1,y:1},world:[{x:1,y:1,terrain:{type:'floor'},occupant:{kind:'creature'}},{x:2,y:1,terrain:{type:'floor'}}]}};
  reader.apply(compact.project(initial,'session.create'));
  const changed = structuredClone(initial); changed.revision++; changed.observation.inventory=[];changed.observation.heard=[];delete changed.observation.you;
  changed.observation.world.pop();delete changed.observation.world[0].occupant;
  const delta=compact.project(changed,'game.move');
  assert.deepEqual(delta.update.worldRemoved,[[2,1]]);assert.deepEqual(delta.update.remove,['you']);
  assert.deepEqual(reader.apply(delta),changed);
  const level=structuredClone(changed);level.observation.location.id='other';
  assert.equal(compact.project(level,'game.climb').update.kind,'snapshot');
  level.sessionId='b';assert.equal(compact.project(level,'session.create').update.kind,'snapshot');
  assert.equal(compact.project(level,'session.observe').update.kind,'snapshot');
});
