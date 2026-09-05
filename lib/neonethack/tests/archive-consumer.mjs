// Copied into a fresh npm consumer by check-archives.mjs. Imports ONLY installed
// package exports and the official MCP SDK, never this checkout's dist/files.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createNative } from 'neonethack/native';
import { createWasm } from 'neonethack/wasm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const prefix = resolve(process.argv[2]);
const paths = { executable: `${prefix}/bin/neonethack`, enginePath: `${prefix}/libexec/neonethack/engine`, dataPath: `${prefix}/share/neonethack/data`, sessionsPath: resolve('native-worlds') };
const hero = { name: 'Packed', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' };
for (const backend of ['native', 'wasm']) {
  const api = backend === 'native' ? createNative(paths) : await createWasm();
  try {
    assert.equal((await api.describe()).capabilities.runtimeProfile, 1);
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
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('node_modules/neonethack/dist/mcp/cli.js'), paths.enginePath, paths.dataPath, resolve('mcp-worlds')],
    env: { NEONETHACK_EXECUTABLE: paths.executable }, stderr: 'pipe',
  }));
  assert.ok((await client.listTools()).tools.length > 20);
  const call = async (name, args) => {
    const result = await client.callTool({ name: `neonethack_${name}`, arguments: args });
    assert.equal(result.isError, false); assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result.structuredContent;
  };
  assert.equal((await call('protocol_describe', {})).capabilities.runtimeProfile, 1);
  const game = await call('session_create', hero);
  const moved = await call('game_wait', { sessionId: game.sessionId, requestId: 'packed-mcp', expectedRevision: game.revision });
  assert.equal(moved.observation.turn, game.observation.turn + 1);
  await call('session_close', { sessionId: game.sessionId });
} finally { await client.close(); }
console.log('Installed npm native/WASM gameplay, consent/resume/receipts and official SDK MCP gameplay passed');
