#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {parseArgs} from 'node:util';
import {createBridge} from './bridge.mjs';
import {createSnapshotClient} from './client.mjs';
import {createAgentHarness} from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const {values} = parseArgs({options: {
  minutes: {type:'string', default:'60'}, seed: {type:'string', default:'217'},
  model: {type:'string', default:'vllm/current'},
  library: {type:'string', default:path.resolve(here, '../../lib/neonethack')},
  output: {type:'string'}, help: {type:'boolean'},
}});
if (values.help) {
  console.log('node examples/agent-harness/run-pi.mjs [--minutes 60] [--seed 217] [--model vllm/current] [--output NEW_DIRECTORY] [--library LIBRARY_DIRECTORY]\nBuilds native MCP, starts one fresh game, and runs Pi with only its MCP tools. Logs, saves and Pi transcript are retained. Stops at death, uncertainty, Pi completion or deadline.');
  process.exit(0);
}
const minutes = Number(values.minutes), seed = Number(values.seed);
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440 || !Number.isSafeInteger(seed) || seed < 0) throw Error('Invalid minutes or seed');
const root = path.resolve(values.library);
const dir = values.output ? path.resolve(values.output) : path.join(os.homedir(), `neohack-pi-${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`);
fs.mkdirSync(dir, {recursive:false});
const buildLog = fs.openSync(path.join(dir,'build.log'), 'wx');
try {
  execFileSync('npm', ['ci','--prefix',here], {stdio:['ignore',buildLog,buildLog]});
  execFileSync('make', ['-C',root,'native'], {stdio:['ignore',buildLog,buildLog]});
  execFileSync('npm', ['ci','--prefix',root], {stdio:['ignore',buildLog,buildLog]});
  execFileSync('npm', ['run','--prefix',root,'build'], {stdio:['ignore',buildLog,buildLog]});
} finally { fs.closeSync(buildLog); }
const {createOperationValidators} = await import('./operations.mjs');
const {CompactObservationReader} = await import(pathToFileURL(path.join(root,'dist/mcp/compact.js')).href);
const bridge = createBridge({command:path.join(root,'build/native/neonethack-mcp'),
  args:[path.join(root,'engine/playground/nethack'),path.join(root,'engine/playground'),path.join(dir,'sessions')],
  journalPath:path.join(dir,'mcp.jsonl'), timeoutMs:30000});
let id=0, child, server, timer, killTimer, busy=false, stopped=false, harness;
const records=[];
const rpc = async (method, params, reservationId) => {
  const request={jsonrpc:'2.0',id:++id,method,params};
  const response=await bridge.rpc(request, reservationId ? {reservationId} : {});
  records.push({request,response});
  if(response.error) throw Error(JSON.stringify(response.error));
  return response;
};
const deadline = Date.now()+minutes*60000;
const metadata={model:values.model,seed,startedAt:new Date().toISOString(),deadline:new Date(deadline).toISOString(),runDir:dir,library:root,tools:'NeoHack MCP only'};
const saveMeta=()=>fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(metadata,null,2)+'\n');
const stop=async(reason)=>{
  if(stopped)return;stopped=true;metadata.stopReason=reason;saveMeta();
  if(child && child.exitCode===null){child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),3000);}
  await bridge.close(reason);
};
try {
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'neohack-pi',version:'1'}});
  await bridge.notify({jsonrpc:'2.0',method:'notifications/initialized'});
  const catalog=(await rpc('tools/list',{})).result.tools;
  const created=(await rpc('tools/call',{name:'create',arguments:{name:'Pi512',seed,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'}})).result.structuredContent;
  if(!created?.sessionId || created.ended)throw Error('No live session created; inspect journal, do not blindly recreate');
  const sessionId=created.sessionId, runId='pi-run'; metadata.sessionId=sessionId;saveMeta();
  const reader=new CompactObservationReader();
  const client=createSnapshotClient({runDir:path.join(dir,'client'),sessionId,
    send:(call,{reservationId})=>rpc('tools/call',call,reservationId),
    decodeReply:raw=>reader.apply(raw.result.structuredContent)});
  const operations=createOperationValidators({sessionId});
  harness=createAgentHarness({runId,sessionId,client,records:()=>records,operations});
  await harness.observe({deliberate:true});
  const excluded=new Set(['create','resume','suspend','recover','receipt']);
  const tools=catalog.filter(t=>!excluded.has(t.name) && (t.annotations?.readOnlyHint || operations.has(t.name))).map(t=>{
    const inputSchema=structuredClone(t.inputSchema);delete inputSchema.properties?.sessionId;
    if(inputSchema.required)inputSchema.required=inputSchema.required.filter(k=>k!=='sessionId');
    return {...t,inputSchema};
  });
  fs.writeFileSync(path.join(dir,'tools.json'),JSON.stringify(tools,null,2));
  const token=randomUUID();
  server=createServer(async(req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(req.headers.authorization!==`Bearer ${token}`)return reply(403,{error:'Unauthorized'});
    if(req.url==='/tools' && req.method==='GET')return reply(200,{tools});
    if(req.url==='/ready' && req.method==='POST'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>1048576){req.destroy();return;}}
      try{const ready=JSON.parse(body);if(!Array.isArray(ready.tools) || ready.tools.length!==tools.length || ready.tools.some(name=>!tools.some(t=>t.name===name)))throw Error('Unexpected Pi tool surface');
        metadata.piReady=ready;saveMeta();return reply(200,{ok:true});
      }catch(error){reply(409,{error:error.message});await stop('invalid Pi tool surface');return;}
    }
    if(req.url!=='/call' || req.method!=='POST')return reply(404,{error:'Unknown endpoint'});
    if(stopped || Date.now()>=deadline)return reply(409,{error:'Run stopped'});
    if(busy)return reply(409,{error:'Another tool call is pending; no input sent'});
    busy=true;
    try {
      let body='';for await(const chunk of req){body+=chunk;if(body.length>1048576)throw Error('Request too large');}
      const call=JSON.parse(body),tool=tools.find(t=>t.name===call.name);
      if(!tool || !call.arguments || typeof call.arguments!=='object' || Array.isArray(call.arguments) || 'sessionId' in call.arguments)throw Error('Invalid bound tool call');
      let result;
      if(call.name==='observe')result=(await harness.observe({deliberate:true})).response;
      else if(tool.annotations?.readOnlyHint){
        const original=catalog.find(t=>t.name===call.name);
        result=(await rpc('tools/call',{name:call.name,arguments:{...call.arguments,...(original.inputSchema.properties?.sessionId?{sessionId}:{})}})).result;
      }else{
        const {state}=await harness.view();
        const response=await harness.dispatch({runId,sessionId,expectedRevision:state.revision,operation:call.name,args:call.arguments,approved:true});
        result=response.response;
      }
      reply(200,result);
      const {state}=await harness.view();
      if(state.snapshot?.ended && state.snapshot?.end?.kind!=='disconnected')setTimeout(()=>stop('terminal'),1500);
    }catch(error){
      reply(409,{error:error.message});
      const state=await client.readSnapshot().catch(()=>null);
      if(state && !['current','empty'].includes(state.status) || state?.pendingRequest)await stop('uncertain execution; inspect durable journal');
    }finally{busy=false;}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  const prompt=`Play this single existing NetHack game as far as you can, aiming for ascension. You have only MCP game tools, bound to your session automatically. Observe first. Choose each action deliberately; inspect exact perceived creature and item references, wield/equip useful starting gear, manage food, avoid melee floating eyes and gas spores, and reassess after every action. Never guess corpse safety or freshness from a glyph. Real decision answers are explicit. Stop on death or uncertain execution; do not recreate games. Navigation is bounded; replan when interrupted rather than blindly repeating. Do not use source code or hidden engine data. Record concise progress in your responses and a final report (state, tactical errors, suspected defects with evidence). The host retains all tool calls, saves, snapshots and this transcript. Session ${sessionId}; deadline ${metadata.deadline}. Continue gameplay until terminal, uncertainty or deadline, not merely after initial setup.`;
  fs.writeFileSync(path.join(dir,'prompt.txt'),prompt);
  const stdout=fs.openSync(path.join(dir,'pi.jsonl'),'wx'),stderr=fs.openSync(path.join(dir,'pi.stderr.log'),'wx');
  child=spawn('pi',['--model',values.model,'--thinking','medium','--no-builtin-tools','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--extension',path.join(here,'pi-extension.mjs'),'--session-dir',path.join(dir,'pi-sessions'),'--mode','json','--print','--system-prompt','You are a careful NetHack player. Only the explicitly provided game MCP tools are available. Use perceived game information; preserve uncertainty and genuine decisions.',prompt],
    {cwd:dir,env:{...process.env,NEOHACK_PI_ENDPOINT:endpoint,NEOHACK_PI_TOKEN:token},stdio:['ignore',stdout,stderr]});
  fs.closeSync(stdout);fs.closeSync(stderr);
  console.log(`Pi ${values.model} started with MCP-only tools. Logs: ${dir}`);
  timer=setTimeout(()=>stop('deadline'),Math.max(1,deadline-Date.now()));
  const onSignal=()=>stop('user interrupt');process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  metadata.piExit=exit;await stop(metadata.stopReason??'pi completed');saveMeta();
  process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);
  console.log(`Run stopped: ${metadata.stopReason}. Logs: ${dir}`);
  if(exit.code && !metadata.stopReason?.includes('deadline'))process.exitCode=exit.code;
} finally {
  clearTimeout(timer);clearTimeout(killTimer);server?.closeAllConnections();
  if(server)await new Promise(resolve=>server.close(resolve));
  await bridge.close();
}
