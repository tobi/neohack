import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture, root} from './native-fixture.mjs';
import {present} from '../dist/mcp/agent.js';
import {scenarioEngine} from './pickup-engine-fixture.mjs';
import {heldContracts, heldNavigationContract} from './held-contracts.mjs';

test('native witnessed held state', async t => {
  const options = await scenarioEngine(t, false, 'held-fixture.inc', 'held_fixture');
  const frames = await heldContracts(t, t => fixture(t, options));
  await t.test('native compact MCP and WebMCP agree with human snapshots', async () => {
    const child = spawn(`${root}/build/native/neonethack-mcp-agent-test`, ['present-compact']);
    let output = '', errors = '';
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
    child.stdin.end(frames.map(JSON.stringify).join('\n') + '\n');
    const [code] = await once(child, 'exit'); assert.equal(code, 0, errors);
    const rendered = output.trim().split('\n').map(JSON.parse);
    assert.equal(rendered.length, frames.length);
    for (let i=0; i<frames.length; i++) {
      const {summary, ...native} = rendered[i], {summary:ignored, ...web} = present(frames[i], {}, true);
      assert.deepEqual(native, web);
      assert.deepEqual(native.observation.vitals, frames[i].observation.vitals);
    }
  });
  await t.test('native MCP stops at the same zero-damage hold', async t => {
    const sessions = await mkdtemp('/tmp/nnh-held-mcp-');
    const client = new Client({name:'held-test', version:'1'});
    t.after(async () => {await client.close(); await rm(sessions, {recursive:true, force:true});});
    await client.connect(new StdioClientTransport({command:`${root}/build/native/neonethack-mcp`,
      args:[options.enginePath, `${root}/engine/playground`, sessions], stderr:'pipe'}));
    await heldNavigationContract(async (name, args) => {
      const result = await client.callTool({name, arguments:args});
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    });
  });
});
