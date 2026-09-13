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
  let execute, inputs=0;
  const registration = await registerWebMcp(
    {
      send() {
        inputs++;
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
  assert.equal(failed.structuredContent.control.gate, 'recoveryRequired');
  assert.equal(failed.structuredContent.outcome.submission, 'unknown');
  assert.equal(failed.structuredContent.error.retry, 'verifyReceipt');
  const blocked=await execute({});
  assert.equal(blocked.structuredContent.control.gate,'recoveryRequired');
  assert.equal(inputs,1,'uncertain creation never starts another run');
  registration.dispose();
});

test('scene snapshots and deltas reconstruct real engine perception', { timeout: 30000 }, async t => {
  const { fixture, identity } = await import('./native-fixture.mjs');
  const {SceneReader, SceneProjector} = await import('../dist/mcp/scene.js');
  const {present} = await import('../dist/mcp/frame.js');
  const { transport } = await fixture(t);
  const projector = new SceneProjector(), reader = new SceneReader();
  let low = await transport.send({version:1,method:'session.create',params:identity});
  let frame = present(low, {full:true});
  assert.deepEqual(reader.apply(projector.project(frame)), frame);
  assert.deepEqual(frame.scene.world, low.observation.world);
  for (let i = 0; i < 4; i++) {
    const base = frame.basis.viewId;
    low = await transport.send({version:1,method:'game.wait',params:{sessionId:low.sessionId,expectedRevision:low.revision,requestId:`scene-${i}`}});
    frame = present(low, {full:true});
    const delta = projector.project(frame, base);
    assert.equal(delta.scene.kind, 'delta');
    assert.equal(delta.observation, undefined);
    assert.deepEqual(reader.apply(delta), frame);
  }
});

test('scene deltas remove cells and optional fields, isolate sessions and reject stale bases atomically', async t => {
  const {SceneProjector, SceneReader} = await import('../dist/mcp/scene.js');
  const initial = {version:2,basis:{sessionId:'a',revision:1,viewId:'a1',levelId:'level',turn:1},
    control:{gate:'ready'},outcome:null,decision:null,events:[],diagnostics:{},summary:'Scene',
    scene:{kind:'snapshot',self:{position:{x:1,y:1},location:{id:'level',depthLabel:'Dlvl:1'},vitals:{}},
      nearby:{status:'unavailable',reason:'unavailable'},entities:[],features:[],map:null,
      inventory:[{id:'opaque'}],inventoryKnown:true,here:{known:true,items:[]},perception:{version:1,inventory:'current',here:'current',equipment:'current'},
      automaticPickup:{enabled:true},navigation:{frontiers:[]},end:null,
      world:[{x:1,y:1,terrain:{type:'floor',knowledge:'remembered'},occupant:{kind:'creature',mark:'g'}},{x:2,y:1,terrain:{type:'floor',knowledge:'remembered'}}]}};
  const advance = (frame, viewId, revision = frame.basis.revision + 1) => ({...structuredClone(frame),basis:{...frame.basis,viewId,revision}});
  await t.test('replacements, removals and scene-less replies', () => {
    const projector = new SceneProjector(), reader = new SceneReader();
    reader.apply(projector.project(initial));
    const noScene = {...advance(initial,'none',99),scene:null};
    assert.equal(reader.apply(projector.project(noScene)).scene, null);
    assert.equal(reader.current('a').basis.viewId, 'a1');
    const next = advance(initial,'a2');
    next.scene.inventory = []; next.scene.world.pop(); delete next.scene.world[0].occupant;
    delete next.scene.automaticPickup; delete next.scene.navigation;
    next.scene.end = {kind:'death',turn:1}; next.control.gate = 'ended';
    const delta = projector.project(next,'a1');
    assert.deepEqual(delta.scene.worldRemoved,[{x:2,y:1}]);
    assert.deepEqual(delta.scene.remove,['automaticPickup','navigation']);
    assert.deepEqual(delta.scene.inventory,[]);
    assert.equal(delta.scene.here,undefined);
    assert.deepEqual(reader.apply(delta),next);
    const absent = advance(next,'a3'); delete absent.scene.world;
    const removal = projector.project(absent,'a2');
    assert.deepEqual(removal.scene.remove,['world']);
    assert.deepEqual(reader.apply(removal),absent);
    const empty = advance(absent,'a4'); empty.scene.world=[];
    assert.deepEqual(reader.apply(projector.project(empty,'a3')),empty);
    const copy = reader.current('a'); copy.scene.inventory.push({id:'mutation'});
    assert.deepEqual(reader.current('a').scene.inventory,[]);
  });
  await t.test('interleaving, level changes and missing requested bases force snapshots', () => {
    const projector = new SceneProjector(), reader = new SceneReader();
    reader.apply(projector.project(initial));
    const other = advance(initial,'b1',1); other.basis.sessionId='b';
    assert.equal(projector.project(other,'a1').scene.kind,'snapshot');
    reader.apply(other);
    const next = advance(initial,'a2');
    assert.deepEqual(reader.apply(projector.project(next,'a1')),next);
    const level = advance(next,'a3'); level.basis.levelId='other'; level.scene.self.location.id='other';
    assert.equal(projector.project(level,'a2').scene.kind,'snapshot');
    reader.apply(level);
    const returned = advance(initial,'a4',4);
    assert.equal(projector.project(returned,'a1').scene.kind,'snapshot');
    const missed = advance(returned,'a5');
    assert.equal(projector.project(missed,'missing').scene.kind,'snapshot');
    assert.equal(projector.project(advance(missed,'a6')).scene.kind,'snapshot');
    assert.equal(reader.current('b').basis.viewId,'b1');
  });
  await t.test('same-view snapshot enrichment and fresh outcome-only deltas', () => {
    const projector = new SceneProjector(), reader = new SceneReader();
    const compact = structuredClone(initial); delete compact.scene.world;
    reader.apply(projector.project(compact));
    assert.deepEqual(reader.apply(projector.project(initial,'a1')),initial);
    const established = advance(initial,'a2');
    const snapshot = projector.project(established,'a1');
    assert.equal(snapshot.scene.kind,'snapshot','same-view enrichment could have been dropped');
    const missed = new SceneReader(); missed.apply(compact);
    assert.deepEqual(missed.apply(snapshot),established);
    reader.apply(snapshot);
    const next = advance(established,'a3'); next.outcome={submission:'notSubmitted',status:'completed'};
    const delta = projector.project(next,'a2');
    assert.deepEqual(delta.scene,{kind:'delta',baseViewId:'a2'});
    assert.deepEqual(reader.apply(delta),next);
    const reused = structuredClone(next); reused.scene.inventory=[];
    assert.throws(()=>reader.apply(reused),/Reused scene view/);
    assert.deepEqual(reader.current('a'),next);
  });
  await t.test('WebMCP advertises the shared output schema and cancellation returns a scene-less v2 frame', async () => {
    const {default:Ajv} = await import('ajv/dist/2020.js');
    const registered = new Map();
    const registration = await registerWebMcp({send:async()=>{throw Error('No input expected');}}, {
      registerTool(tool){registered.set(tool.name,tool);},unregisterTool(name){registered.delete(name);}
    });
    try {
      for (const tool of tools) assert.deepEqual(registered.get(tool.name).outputSchema,tool.outputSchema);
      const controller = new AbortController(); controller.abort();
      const tool = registered.get('create');
      const result = await tool.execute({}, {signal:controller.signal});
      assert.equal(result.isError,true);
      assert.equal(result.structuredContent.version,2);
      assert.equal(result.structuredContent.scene,null);
      const validate = new Ajv({strict:false}).compile(tool.outputSchema);
      assert.ok(validate(result.structuredContent),JSON.stringify(validate.errors));
    } finally {registration.dispose();}
  });
  await t.test('bad deltas never overwrite the retained basis or bind a newer question', () => {
    const projector = new SceneProjector(), reader = new SceneReader();
    reader.apply(projector.project(initial));
    const next = advance(initial,'a2');
    const delta = projector.project(next,'a1');
    const malformed = [
      {...delta,version:1}, {...delta,basis:null},
      {...delta,basis:{...delta.basis,sessionId:'b'}},
      {...delta,basis:{...delta.basis,levelId:'other'}},
      {...delta,basis:{...delta.basis,revision:0}},
      {...delta,basis:{...delta.basis,viewId:'a1'}},
      {...delta,scene:{...delta.scene,baseViewId:'missing'}},
      {...delta,scene:{...delta.scene,remove:['inventory']}},
      {...delta,scene:{...delta.scene,remove:['navigation','navigation']}},
      {...delta,scene:{...delta.scene,self:{...initial.scene.self,location:{id:'wrong'}}}},
      {...delta,scene:{...delta.scene,remove:['world'],world:[]}},
      {...delta,scene:{...delta.scene,worldRemoved:[{x:99,y:99}]}},
      {...delta,scene:{...delta.scene,world:[initial.scene.world[0]],worldRemoved:[{x:1,y:1}]}}
    ];
    for (const bad of malformed) {
      assert.throws(()=>reader.apply(bad),/snapshot.*Never resend gameplay/);
      assert.deepEqual(reader.current('a'),initial);
    }
    assert.deepEqual(reader.arguments('a',{decisionId:'exact-question'}),{sessionId:'a',viewId:'a1',decisionId:'exact-question'});
    assert.throws(()=>reader.arguments('missing'),/Missing scene basis/);
    assert.throws(()=>reader.arguments('a',{viewId:'newer'}),/Conflicting/);
    assert.throws(()=>reader.arguments('a',{sessionId:'b'}),/Conflicting/);
    assert.deepEqual(reader.apply(delta),next);
    assert.throws(()=>reader.apply(delta),/baseline/);
    assert.throws(()=>reader.apply(initial),/Stale/);
    const sameRevision = advance(next,'a2-read',2);
    reader.apply(sameRevision);
    assert.throws(()=>reader.apply(next),/Stale/);
    assert.deepEqual(reader.current('a'),sameRevision);
  });
});

test('default WebMCP agent profile exposes navigation and owns exact input guards', async t => {
  const {fixture, identity} = await import('./native-fixture.mjs');
  const {withSessionViews} = await import('./mcp-view-fixture.mjs');
  const {transport} = await fixture(t), registered = new Map(), requests = [];
  const registration = await registerAgentWebMcp({async send(request) {
    requests.push(structuredClone(request)); return transport.send(request);
  }}, {registerTool(tool) { registered.set(tool.name, tool); }, unregisterTool(name) { registered.delete(name); }});
  t.after(() => registration.dispose());
  assert.ok(registered.has('go')); assert.ok(!registered.has('game_move'));
  const call = withSessionViews(async (name, args) => (await registered.get(name).execute(args)).structuredContent);
  const created = await call("create", identity), sid = {sessionId: created.basis.sessionId};
  assert.equal(created.scene.world,undefined); assert.equal(created.scene.kind,'snapshot'); assert.equal(created.observation, undefined);
  const observed=await call("syncState",sid);
  assert.ok(observed.scene.world);assert.equal(observed.outcome.submission,'notSubmitted');
  const waited = await call("wait", sid);
  assert.equal(waited.basis.turn, created.basis.turn + 1);
  const submitted=requests.filter(r=>r.method==='game.wait');
  assert.equal(submitted.length,1);
  assert.equal(submitted[0].params.expectedRevision, created.basis.revision);
  assert.equal(submitted[0].params.requestId, waited.outcome.operationId);
  assert.equal(requests.at(-1).method,'session.navigation');
  assert.equal(requests.at(-1).params.expectedRevision,waited.basis.revision);
  assert.equal(waited.scene.navigation.status,'available');
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
