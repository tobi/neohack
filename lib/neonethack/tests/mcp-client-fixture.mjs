import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {mcpExecutable,startMcpHttp} from './mcp-fixture.mjs';
export async function mcpClient(t,mode,{sessionsPath,runtimePath}={}){
  const directory=sessionsPath??await mkdtemp(tmpdir()+'/mcp-wasm-');
  let client,server;
  async function open(){
    client=new Client({name:'shared-mcp-test',version:'1'});
    if(mode==='http'){server=await startMcpHttp({sessionsPath:directory,runtimePath});await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));}
    else await client.connect(new StdioClientTransport({command:mcpExecutable,args:['--sessions',directory,...(runtimePath?['--runtime',runtimePath]:[])],stderr:'pipe'}));
  }
  const close=async()=>{await client?.close();await server?.close();};
  await open();t.after(async()=>{await close();if(!sessionsPath)await rm(directory,{recursive:true,force:true});});
  return {directory,client:()=>client,server:()=>server,restart:async()=>{await close();await open();},
    call:async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.deepEqual(JSON.parse(r.content[0].text),r.structuredContent);return r.structuredContent;}};
}
