import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpRuntime} from '../dist/mcp/runtime.js';
for(const [name,data,expected] of [
  ['corrupt descriptor','not JSON',SyntaxError],
  ['missing pinned runtime',JSON.stringify({version:1,buildId:'a'.repeat(64)}),{code:'ENOENT'}],
])test(`resume does not mislabel ${name} as an unknown session`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mcp-loading-')),sessionId='MissingRun123456';
  const runtime=new McpRuntime(directory);
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const run=join(directory,'runs',sessionId);await mkdir(run,{recursive:true});
  await writeFile(join(run,'runtime.json'),data);
  await assert.rejects(runtime.send({version:1,method:'session.resume',params:{sessionId}}),expected);
});
