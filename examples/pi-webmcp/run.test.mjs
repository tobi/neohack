import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import register, {pageTools} from './run.mjs';
import {agentTools} from '../../lib/neonethack/protocol/agent.ts';

test('page discovery retains every game tool including read, with separate file names', () => {
  const origin='https://example.test';
  const tools=agentTools.map(tool=>({...tool,origin,frameId:'fixture-frame'}));
  assert.deepEqual(pageTools({data:{tools}},origin),tools);
  assert.ok(tools.some(tool=>tool.name==='read'));
  assert.throws(()=>pageTools({data:{tools:[...tools,{...tools[0],name:'read_file'}]}},origin),/conflicting/);
});

test('Pi registers game read alongside read_file and write_file and verifies the active set', async t => {
  const runDir=await mkdtemp(join(tmpdir(),'nnh-pi-web-tools-'));
  const old=process.env.NEOHACK_WEBMCP_RUN;
  t.after(async()=>{if(old===undefined)delete process.env.NEOHACK_WEBMCP_RUN;else process.env.NEOHACK_WEBMCP_RUN=old;await rm(runDir,{recursive:true,force:true});});
  process.env.NEOHACK_WEBMCP_RUN=join(runDir,'run.json');
  await writeFile(process.env.NEOHACK_WEBMCP_RUN,JSON.stringify({runDir}));
  await writeFile(join(runDir,'tools.json'),JSON.stringify(agentTools));
  const tools=[],events=new Map(),fileTool=name=>cwd=>({name,description:name,parameters:{type:'object'},execute:async()=>cwd});
  await register({registerTool:tool=>tools.push(tool),on:(event,fn)=>events.set(event,fn),getActiveTools:()=>tools.map(t=>t.name)},
    {createReadToolDefinition:fileTool('read'),createWriteToolDefinition:fileTool('write')});
  assert.equal(new Set(tools.map(t=>t.name)).size,agentTools.length+2);
  assert.equal(await tools.find(t=>t.name==='read_file').execute(),runDir);
  assert.deepEqual(tools.find(t=>t.name==='read').parameters,agentTools.find(t=>t.name==='read').inputSchema);
  await events.get('session_start')({}, {model:{provider:'fixture',id:'fixture'}});
  assert.equal(JSON.parse(await readFile(join(runDir,'pi-ready.json'),'utf8')).tools.length,agentTools.length+2);
});
