import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { serveExample } from '../../scripts/serve-example.mjs';

for (const fault of ['lost', 'slow']) test(`browser WebMCP ${fault} create reply is recovered without another creation`, { timeout: 60000 }, async t => {
  const server = await serveExample();
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  });
  const executablePath = process.env.CHROMIUM ?? await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const page = await browser.newPage(); // New origin store for every scenario.
  await page.goto(`http://127.0.0.1:${server.address().port}/lib/neonethack/docs/REPLAY.md`);
  const result = await page.evaluate(async fault => {
    const { WasmTransport } = await import('/lib/neonethack/dist/typescript/wasm.js');
    const { registerWebMcp } = await import('/lib/neonethack/dist/typescript/webmcp.js');
    const options = { storage: { kind: 'indexeddb', name: 'lifecycle-fresh' } };
    const transport = await WasmTransport.create(options), buildId = transport.buildId;
    const tools = new Map();
    const host = document.createElement('div'); document.body.append(host);
    let creates = 0, release, ownedCreation;
    const slow = new Promise(resolve => { release = resolve; });
    const registration = await registerWebMcp({ async send(request) {
      if (request.method === 'session.create') creates++;
      const response = await transport.send(request);
      if (response.observation) host.dataset.sessionId = response.sessionId;
      if (request.method === 'session.create') {
        ownedCreation = response;
        if (fault === 'lost') throw Error('injected lost reply after owner received frame');
        await slow;
      }
      return response;
    } }, { registerTool(tool) { tools.set(tool.name, tool); } });
    const start = performance.now();
    // An invocation handle survives a supervisor timeout; it is not a game request ID.
    const invocation = tools.get("create").execute({ name: 'Fresh', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
    while (!host.dataset.sessionId) await new Promise(resolve => setTimeout(resolve, 10));
    const createMs = performance.now() - start;
    const sessionId = host.dataset.sessionId;
    const observed = await tools.get("observe").execute({ sessionId });
    let settled = false; invocation.then(() => { settled = true; });
    await Promise.resolve();
    const pendingBeforeRelease = !settled;
    release();
    const recovered = await invocation;
    const recoveredFrame = recovered.isError ? null : recovered.structuredContent;
    const description = await transport.send({ version: 1, method: 'protocol.describe', params: {} });
    let ownerError = '';
    try { await WasmTransport.create(options); } catch (error) { ownerError = String(error); }
    registration.dispose(); await transport.close();
    const resumed = await WasmTransport.create(options);
    const sameBuild = resumed.buildId === buildId;
    const frame = await resumed.send({ version: 1, method: 'session.resume', params: { sessionId } });
    await resumed.close();
    return { ownedCreation, creates, createMs, buildId, description, pendingBeforeRelease, recovered, recoveredFrame, observed, frame, ownerError, sameBuild };
  }, fault);
  assert.equal(result.creates, 1);
  assert.equal(result.observed.isError, false);
  assert.equal(result.observed.structuredContent.observation.turn, 1);
  assert.equal(result.observed.structuredContent.revision, 0);
  assert.deepEqual(result.frame.observation, result.observed.structuredContent.observation);
  assert.equal(result.frame.sessionId, result.observed.structuredContent.sessionId);
  assert.equal(result.sameBuild, true);
  assert.equal(result.description.capabilities.ownership, 'origin-web-lock');
  assert.equal(result.description.capabilities.runtimeProfile, 1);
  assert.match(result.ownerError, /owns|owned|owner|lock/i);
  if (fault === 'lost') {
    assert.equal(result.recovered.isError, true);
    assert.match(result.recovered.structuredContent.summary, /Do not resubmit create/);
  } else {
    assert.equal(result.pendingBeforeRelease, true);
    const expected = structuredClone(result.ownedCreation);
    assert.deepEqual(result.recoveredFrame.presentation.omitted,['observation.neighborhood']);
    assert.equal(result.recoveredFrame.presentation.fullObservation,"observe");
    delete expected.observation.neighborhood;
    assert.deepEqual(result.recoveredFrame.observation, expected.observation);
    assert.equal(result.recoveredFrame.sessionId, expected.sessionId);
    assert.equal(result.recoveredFrame.revision, expected.revision);
    assert.equal(typeof result.recoveredFrame.summary, 'string');
  }
  t.diagnostic(JSON.stringify({ fault, createMs: result.createMs, buildId: result.buildId, creates: result.creates }));
});
