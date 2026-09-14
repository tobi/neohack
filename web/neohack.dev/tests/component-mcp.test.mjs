import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';

async function fixture(t) {
  const server = spawn('bun', ['server.ts'], {
    cwd: resolve(import.meta.dirname, '..'), env: {...process.env, PORT:'0'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill('SIGTERM'));
  const url = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(Error(`Server did not start: ${log}`)), 10000);
    const read = chunk => {
      log += chunk;
      const match = /neohack READY (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
      if(match) { clearTimeout(timer); resolve(match[1]); }
    };
    server.stdout.on('data', read); server.stderr.on('data', read);
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.on('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${log}`)); });
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    headless:true, chromiumSandbox:true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${url}/component`);
  await page.waitForFunction(() => !!document.querySelector('neohack-world')?.postMessage);
  return page;
}

test('component shares agent frames across message and WebMCP calls, retaining low readonly admission', {timeout:120000}, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const world = document.querySelector('neohack-world');
    const {tools,readOnlyTools} = await import('/component/neohack.js');
    const {WasmTransport} = await import('/runtime/typescript/wasm.js');
    const call = (method, params) => world.postMessage({jsonrpc:'2.0', id:'component-test', method, params});
    const invoke = (name, args) => call('tools/call', {name, arguments:args});
    const unconnected = await call('tools/list');
    const unconnectedCall = await invoke("interact", {action: "rest"});
    const transport = await WasmTransport.create({storage:{kind:'memory'}});
    const sent = [];
    const traced = {send(request) { sent.push(request); return transport.send(request); }};
    const registry = new Map();
    const context = {
      registerTool(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    };
    try {
      const low = world.connect(traced, {writable:true});
      const listed = (await call('tools/list')).result.tools;
      const registration = await world.registerWebMcp(context);
      const created = (await invoke("session", {action: "create", seed:42, role:'valkyrie'})).result;
      const first = created.structuredContent;
      const sessionId = first.basis.sessionId;
      const waited = await registry.get('interact').execute({action:'rest',sessionId, viewId:first.basis.viewId});
      const beforeStale = sent.length;
      const stale = (await invoke("interact", {action: "rest", sessionId, viewId:first.basis.viewId})).result;
      const staleSent = sent.length - beforeStale;
      const beforeAbort = sent.length;
      const abort = new AbortController(); abort.abort();
      const cancelled = await registry.get('interact').execute({action:'rest',sessionId, viewId:waited.structuredContent.basis.viewId}, {signal:abort.signal});
      const abortSent = sent.length - beforeAbort;
      const prayer = (await invoke("interact", {action: "pray", sessionId, viewId:waited.structuredContent.basis.viewId})).result;
      const question = prayer.structuredContent.decision;
      const answered = await registry.get('respond').execute({...question.reply.arguments, value:false});
      const snapshot = world.snapshot;
      const oldWait = registry.get('interact');
      const readonly = world.connect(traced);
      const disposedNames = [...registry.keys()];
      await low.close(); // Old owners cannot detach a replacement connection.
      const readTools = (await call('tools/list')).result.tools;
      const readRegistration = await world.registerWebMcp(context);
      const readRegistry = [...registry.keys()];
      const beforeDenied = sent.length;
      const denied = await invoke("interact", {action: "rest", sessionId, viewId:answered.structuredContent.basis.viewId});
      const readOnlyMutation=await registry.get('use').execute({action:'read',sessionId,viewId:answered.structuredContent.basis.viewId});
      let lowDenied = false;
      try { await readonly.request('game.wait', {sessionId, requestId:'forbidden', expectedRevision:snapshot.revision}); }
      catch(error) { lowDenied = /read-only/.test(String(error)); }
      const retired = await oldWait.execute({sessionId, viewId:answered.structuredContent.basis.viewId});
      let oldClientDenied = false;
      try { await low.request('session.observe', {sessionId}); } catch { oldClientDenied = true; }
      const deniedSent = sent.length - beforeDenied;
      const synced = await registry.get('observe').execute({sessionId});
      const readOnlyDiscovery=await registry.get('use').execute({sessionId});
      await readonly.describe(); // Low discovery remains available privately.
      let message;
      world.addEventListener('message', event => { message = event.data; }, {once:true});
      const rendered = await call('world.render', {snapshot});
      const emitted = message;
      await call('replay.load', {frames:[snapshot, snapshot]});
      const seek = await call('replay.seek', {index:1});
      await call('replay.play', {interval:10000});
      await call('replay.pause');
      const displayed = await call('world.snapshot');
      readRegistration.dispose(); registration.dispose();
      await readonly.close();
      let settle;
      const lateClient = world.connect({send:() => new Promise(resolve => { settle = resolve; })});
      const late = lateClient.request('session.observe', {sessionId});
      let finishRegistration;
      const registering = new Promise(resolve => { finishRegistration = resolve; });
      const delayedRegistry = new Map();
      const pendingRegistration = world.registerWebMcp({async registerTool(tool) {
        await registering;
        delayedRegistry.set(tool.name, tool);
        return () => delayedRegistry.delete(tool.name);
      }});
      const replacement = world.connect(traced);
      world.snapshot = null;
      settle(snapshot);
      const lateResult = await late;
      finishRegistration();
      await pendingRegistration;
      const lateDidNotPaint = world.snapshot === null;
      await lateClient.close();
      const replacementTools = (await call('tools/list')).result.tools.length;
      await replacement.close();
      return {
        unconnected:unconnected.result.tools, unconnectedCall:!!unconnectedCall.error,
        sameCatalog:JSON.stringify(listed) === JSON.stringify(tools), registered:registration.toolCount,
        outputVersions:listed.map(tool => tool.outputSchema.properties.version.const),
        first, waited:waited.structuredContent, stale:stale.structuredContent, staleSent,
        cancelled:cancelled.structuredContent, abortSent, question, answered:answered.structuredContent,
        disposedNames, readonlyNames:readTools.map(tool => tool.name), readRegistry,
        expectedReadonly:readOnlyTools.map(tool => tool.name),
        denied:!!denied.error, readOnlyMutation:readOnlyMutation.isError, readOnlyDiscovery:readOnlyDiscovery.structuredContent,lowDenied, retired:retired.isError, oldClientDenied, deniedSent,
        synced:synced.structuredContent, sameMessage:JSON.stringify(rendered) === JSON.stringify(emitted),
        seek:seek.result, sameSnapshot:JSON.stringify(displayed.result) === JSON.stringify(snapshot),
        remainingRegistry:registry.size, disconnected:(await call('tools/list')).result.tools,
        lateDidNotPaint, lateResultRevision:lateResult.revision, originalRevision:snapshot.revision,
        delayedRegistrySize:delayedRegistry.size, replacementTools,
      };
    } finally { await transport.close(); }
  });
  assert.deepEqual(result.unconnected, []);
  assert.equal(result.unconnectedCall, true);
  assert.equal(result.readOnlyMutation,true);
  assert.equal(result.readOnlyDiscovery.result.kind,'itemActions');
  assert.equal(result.readOnlyDiscovery.outcome.actionsTaken,0);
  assert.equal(result.sameCatalog, true);
  assert.equal(result.registered, result.outputVersions.length);
  assert.ok(result.outputVersions.every(version => version === 2));
  assert.equal(result.first.version, 2);
  for(const field of ['state','observation','messages','context','reply']) assert.equal(field in result.first, false);
  assert.equal(result.waited.outcome.submission, 'accepted');
  assert.ok(result.waited.basis.revision > result.first.basis.revision);
  assert.equal(result.stale.error.code, 'staleView');
  assert.equal(result.staleSent, 0);
  assert.equal(result.cancelled.error.code, 'cancelled');
  assert.equal(result.abortSent, 0);
  assert.equal(result.question.reply.arguments.decisionId, result.question.id);
  assert.equal(result.answered.decision, null);
  assert.equal(result.answered.outcome.submission, 'accepted');
  assert.deepEqual(result.disposedNames, []);
  assert.deepEqual(result.readonlyNames, result.expectedReadonly);
  assert.deepEqual(result.readRegistry, result.expectedReadonly);
  for(const field of ['denied','lowDenied','retired','oldClientDenied','sameMessage','sameSnapshot']) assert.equal(result[field], true, field);
  assert.equal(result.deniedSent, 0);
  assert.ok(result.synced.scene.world.length);
  assert.deepEqual(result.seek, {index:1, length:2});
  assert.equal(result.remainingRegistry, 0);
  assert.deepEqual(result.disconnected, []);
  assert.equal(result.lateDidNotPaint, true);
  assert.equal(result.lateResultRevision, result.originalRevision);
  assert.equal(result.delayedRegistrySize, 0);
  assert.equal(result.replacementTools, result.expectedReadonly.length);
});
