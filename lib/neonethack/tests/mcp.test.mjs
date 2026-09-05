import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root, identity } from './native-fixture.mjs';

test('official MCP SDK stdio roundtrip exposes strict tools and structured results', { timeout: 30_000 }, async t => {
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-mcp-`);
  const client = new Client({ name: 'contract-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [`${root}/dist/mcp/cli.js`, `${root}/engine/playground/nethack`, `${root}/engine/playground`, sessions],
    env: { NEONETHACK_EXECUTABLE: `${root}/build/native/neonethack` },
    stderr: 'pipe',
  });
  t.after(async () => { await client.close(); await rm(sessions, { recursive: true, force: true }); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'neonethack_game_move'));
  assert.ok(!tools.some(tool => tool.name === 'act'));
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false && tool.outputSchema));
  const invoke = (name, args) => client.callTool({ name: `neonethack_${name}`, arguments: args });
  const created = await invoke('session_create', identity);
  assert.equal(created.isError, false);
  const state = created.structuredContent;
  assert.deepEqual(JSON.parse(created.content[0].text), state);
  const bad = await invoke('game_wait', { sessionId: state.sessionId, requestId: 'typo', expectedRevision: state.revision, direction: 'south' });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error.code, 'invalidParams');
  const prayerArgs = { sessionId: state.sessionId, requestId: 'prayer', expectedRevision: state.revision };
  const prayer = (await invoke('game_pray', prayerArgs)).structuredContent;
  assert.equal(prayer.decision.kind, 'confirmation');
  assert.deepEqual((await invoke('game_pray', prayerArgs)).structuredContent, prayer);
  const declined = await invoke('decision_answer', { sessionId: state.sessionId, requestId: 'decline', expectedRevision: prayer.revision, decisionId: prayer.decision.id, answer: { kind: 'confirmation', confirm: false } });
  assert.equal(declined.isError, false);
  assert.equal(declined.structuredContent.decision, null);
  await invoke('session_close', { sessionId: state.sessionId });
});
