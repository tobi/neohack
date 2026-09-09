import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { identity, root } from './native-fixture.mjs';

test('installed C MCP finds engine and data next to the executable', { timeout: 30_000 }, async t => {
  const prefix = await mkdtemp(`${tmpdir()}/neonethack-mcp-prefix-`);
  const home = await mkdtemp(`${tmpdir()}/neonethack-mcp-home-`);
  t.after(() => Promise.all([rm(prefix, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const installed = spawnSync('cmake', ['--install', `${root}/build/native`, '--prefix', prefix], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state`, PATH: '/nonexistent' };
  delete env.LD_LIBRARY_PATH;
  const version = spawnSync(`${prefix}/bin/neonethack-mcp`, ['--version'], { encoding: 'utf8', env });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  const client = new Client({ name: 'mcp-install-test', version: '1' });
  const transport = new StdioClientTransport({ command: `${prefix}/bin/neonethack-mcp`, args: [], env, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const created = await client.callTool({ name: 'create', arguments: identity });
  assert.equal(created.isError, false, JSON.stringify(created));
  assert.equal(typeof created.structuredContent.sessionId, 'string');
});
