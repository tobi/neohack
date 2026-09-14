// Copied into a fresh npm consumer by check-archives.mjs. Imports ONLY installed
// package exports and the official MCP SDK, never this checkout's dist/files.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createNative } from 'neonethack/native';
import { createWasm } from 'neonethack/wasm';
import { registerWebMcp } from 'neonethack/webmcp';
import { SceneReader, SceneProjector } from 'neonethack/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const prefix = resolve(process.argv[2]);
const paths = { executable: `${prefix}/bin/neonethack`, enginePath: `${prefix}/libexec/neonethack/engine`, dataPath: `${prefix}/share/neonethack/data`, sessionsPath: resolve('native-worlds') };
const hero = { name: 'Packed', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };
async function consumeAgent(call) {
  const reader = new SceneReader();
  assert.ok((await call("help", {})).result.tools.some(tool=>tool.name==='travel'));
  const created = reader.apply(await call("session", {action: "create", ...hero,includeWorld:true}));
  const sid = created.basis.sessionId;
  assert.equal(created.version,2); assert.ok(created.scene.world.length);
  assert.equal(created.observation,undefined);
  // Importing the installed projector must resolve its entire runtime graph.
  assert.deepEqual(new SceneProjector().project(created),created);
  const delta = await call("interact", {action: "rest", ...(reader.arguments(sid,{includeWorld:true,sinceViewId:created.basis.viewId}))});
  assert.equal(delta.scene.kind,'delta');
  const waited = reader.apply(delta);
  assert.equal(waited.basis.turn,created.basis.turn+1);
  const pending = reader.apply(await call("interact", {action: "pray", ...(reader.arguments(sid,{includeWorld:true}))}));
  assert.equal(pending.control.gate,'decision');
  assert.equal(pending.decision.kind,'confirmation');
  const historical = reader.apply(await call("observe", {sessionId:sid,operationId:waited.outcome.operationId}));
  assert.equal(historical.result.historical,true);
  assert.equal(historical.result.receipt.decision,null);
  assert.equal(historical.basis.viewId,pending.basis.viewId);
  assert.deepEqual(historical.control,pending.control);
  assert.deepEqual(historical.decision,pending.decision,'historical evidence cannot clear the current question');
  const answered = reader.apply(await call("respond", {action: "answer", ...pending.decision.reply.arguments,value:false}));
  assert.equal(answered.control.gate,'ready'); assert.equal(answered.decision,null);
  const oldQuestion = reader.apply(await call("observe", {sessionId:sid,operationId:pending.outcome.operationId}));
  assert.equal(oldQuestion.result.receipt.decision.id,pending.decision.id);
  assert.equal(oldQuestion.decision,null,'historical questions must not become executable');
  assert.equal(oldQuestion.control.gate,'ready');
  assert.equal(oldQuestion.basis.viewId,answered.basis.viewId);
  const current = reader.apply(await call("observe", {sessionId:sid}));
  assert.equal(current.basis.viewId,answered.basis.viewId);
  assert.deepEqual(current.events,[]);
  await call("session", {action: "suspend", sessionId:sid});
}
for (const backend of ['native', 'wasm']) {
  const api = backend === 'native' ? createNative(paths) : await createWasm();
  try {
    assert.equal((await api.describe()).capabilities.runtimeProfile, 1);
    // Installed public exports must register the complete catalog and reach the
    // actual C backend. Browser-native registration is tested separately.
    const registered = new Map();
    const registration = await registerWebMcp(api.transport, {
      registerTool(tool) { registered.set(tool.name, tool); },
      unregisterTool(name) { registered.delete(name); },
    });
    assert.equal(registration.supported, true);
    assert.equal(registration.toolCount, registered.size);
    assert.equal(registered.size,11);
    assert.ok(registered.has('travel') && registered.has('use') && registered.has('interact'));
    assert.ok(!registered.has('step') && !registered.has('go') && !registered.has('game_move'));
    assert.ok([...registered.values()].every(tool=>tool.outputSchema));
    await consumeAgent(async (name,args) => {
      const result = await registered.get(name).execute(args);
      assert.equal(result.isError,false,JSON.stringify(result.structuredContent));
      return result.structuredContent;
    });
    registration.dispose(); assert.equal(registered.size, 0);
    const game = await api.create(hero);
    const request = { sessionId: game.id, requestId: 'once', expectedRevision: game.state.revision };
    const receipt = await api.request('game.wait', request);
    assert.equal(receipt.error, undefined); assert.equal(receipt.revision, 1);
    await game.observe();
    const pending = await game.pray(); assert.equal(pending.decision.kind, 'confirmation');
    await game.close();
    const restored = await api.resume(game.id);
    assert.deepEqual(restored.observation, pending.observation); assert.deepEqual(restored.decision, pending.decision);
    assert.deepEqual(await api.request('game.wait', request), receipt);
    await restored.answer(restored.decision.id, { kind: 'confirmation', confirm: false });
    await restored.close();
  } finally { await api.close(); }
}
const client = new Client({ name: 'packed-consumer', version: '1' });
try {
  await client.connect(new StdioClientTransport({ command: resolve('node_modules/.bin/neohack-mcp'),
    args: ['--sessions',resolve('mcp-worlds')],
    stderr: 'pipe',
  }));
  assert.equal((await client.listTools()).tools.length,11);
  const call = async (name, args) => {
    const result = await client.callTool({ name: `${name}`, arguments: args });
    assert.equal(result.isError, false); assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
    return result.structuredContent;
  };
  await consumeAgent(call);
} finally { await client.close(); }
console.log('Installed npm native/WASM gameplay, consent/resume/receipts, WebMCP exports and official SDK MCP bin gameplay passed');
