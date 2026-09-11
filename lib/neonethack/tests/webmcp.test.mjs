import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWebMcp as registerAgentWebMcp } from "../dist/typescript/webmcp.js";
const registerWebMcp = registerAgentWebMcp;
import { tools } from "../dist/mcp/agent-data.js";

test("WebMCP navigation registration, validation, abort and cleanup", async () => {
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
    assert.equal(sent.length,0,'invalid caller guards never reach the engine');
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.structuredContent.error.code, "invalidParams");
  }
  const callback = registered.values().next().value.execute;
  const cancelled = new AbortController();
  cancelled.abort();
  await callback({}, { signal: cancelled.signal });
  assert.equal(
    sent.length,
    0,
    "aborted invocation never reaches transport",
  );
  registration.dispose();
  assert.equal(registered.size, 0);
  assert.equal((await callback({})).isError, true);
  assert.equal(sent.length, 0, "retired callbacks cannot submit");
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
        if(tool.name === "create")execute = tool.execute;
      },
      unregisterTool() {},
    },
  );
  const failed = await execute({});
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.summary, /Do not resubmit create/);
  registration.dispose();
});

test("low-level compaction reconstructs real engine perception and reduces movement payload", { timeout: 30000 }, async t => {
  const { fixture, identity } = await import('./native-fixture.mjs');
  const { CompactObservationReader } = await import('../dist/mcp/compact.js');
  const { transport } = await fixture(t);
  const {CompactResponses}=await import('../dist/mcp/compact.js');
  const compact=new CompactResponses();let full;
  const reader = new CompactObservationReader(); let state, bytes = 0, original = 0;
  const call = async (method, args) => {
    full=await transport.send({version:1,method:method.replace('_','.'),params:args});
    const result={structuredContent:compact.project(full,method.replace('_','.'))};
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

test('default WebMCP agent profile exposes navigation and owns exact input guards', async t => {
  const {fixture, identity} = await import('./native-fixture.mjs');
  const {transport} = await fixture(t), registered = new Map(), requests = [];
  const registration = await registerAgentWebMcp({async send(request) {
    requests.push(structuredClone(request)); return transport.send(request);
  }}, {registerTool(tool) { registered.set(tool.name, tool); }, unregisterTool(name) { registered.delete(name); }});
  t.after(() => registration.dispose());
  assert.ok(registered.has('go')); assert.ok(!registered.has('game_move'));
  const call = async (name, args) => (await registered.get(name).execute(args)).structuredContent;
  const created = await call("create", identity), sid = {sessionId: created.sessionId};
  assert.equal(created.observation.neighborhood,undefined); assert.equal(created.presentation.kind,'compact'); assert.equal(created.update, undefined);
  const observed=await call("observe",sid);
  assert.ok(observed.observation.neighborhood);assert.equal(observed.presentation,undefined);
  const waited = await call("wait", sid);
  assert.equal(waited.observation.turn, created.observation.turn + 1);
  const submitted=requests.filter(r=>r.method==='game.wait');
  assert.equal(submitted.length,1);
  assert.equal(submitted[0].params.expectedRevision, created.revision);
  assert.equal(submitted[0].params.requestId, waited.operationId);
  assert.equal(requests.at(-1).method,'session.navigation');
  assert.equal(requests.at(-1).params.expectedRevision,waited.revision);
  assert.equal(waited.context.status,'available');
  assert.equal(waited.requestId, undefined); assert.ok(waited.summary);
  const before = requests.length;
  assert.equal((await call("wait", {...sid, expectedRevision: 0})).error.code, 'invalidParams');
  assert.equal(requests.length, before);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await registered.get("wait").execute(sid, {signal: cancelled.signal})).isError, true);
  assert.equal(requests.length, before);
  registration.dispose(); assert.equal(registered.size, 0);
});

test('earlier WebMCP returned cleanup callbacks are retained and disposed once',async()=>{
  const registered=new Map();let removed=0;
  const binding=await registerWebMcp({send:async()=>{throw Error('No input expected');}}, {registerTool(tool){registered.set(tool.name,tool);return ()=>{registered.delete(tool.name);removed++;};}});
  assert.equal(binding.toolCount,tools.length);binding.dispose();binding.dispose();
  assert.equal(registered.size,0);assert.equal(removed,tools.length);
});
