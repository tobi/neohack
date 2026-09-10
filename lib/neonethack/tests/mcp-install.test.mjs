import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {root,identity} from './native-fixture.mjs';
test('installed Bun MCP relocates with WASM and needs no native engine or data arguments',async t=>{
  const dir=await mkdtemp(tmpdir()+'/mcp-install-');t.after(()=>rm(dir,{recursive:true,force:true}));
  execFileSync(process.execPath,[root+'/scripts/install-mcp.mjs',dir+'/original']);await rename(dir+'/original',dir+'/moved');
  const client=new Client({name:'install',version:'1'});t.after(()=>client.close());
  await client.connect(new StdioClientTransport({command:dir+'/moved/bin/neohack-mcp',args:['--sessions',dir+'/sessions'],stderr:'pipe'}));
  const r=await client.callTool({name:'create',arguments:identity});assert.equal(r.isError,false,JSON.stringify(r));assert.match(r.structuredContent.sessionId,/^[\w-]{16}$/);
  assert.ok((await client.listTools()).tools.some(t=>t.name==='explore'));
});
