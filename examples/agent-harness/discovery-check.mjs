#!/usr/bin/env node
/** Opt-in usability check: fresh Pi model, full live MCP catalog, local games. */
import{mkdtemp,writeFile,rm,mkdir}from'node:fs/promises';
import{openSync,closeSync}from'node:fs';import{tmpdir}from'node:os';
import{resolve,join}from'node:path';import{spawn}from'node:child_process';
import{parseArgs}from'node:util';import{createRequire}from'node:module';
import{createServer}from'node:http';import{randomUUID}from'node:crypto';
const require=createRequire(new URL('../../lib/neonethack/package.json',import.meta.url));
const{Client}=await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const{StdioClientTransport}=await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
const{values}=parseArgs({options:{out:{type:'string'},model:{type:'string',default:'vllm/current'},help:{type:'boolean'}}});
if(values.help){console.log('node examples/agent-harness/discovery-check.mjs --out /tmp/discovery-check [--model vllm/current]\nRequires built native MCP and configured Pi. Full catalog, at most 9 tool calls and 2 minutes; no input retries or production requests. Raw evidence is private; summary.json is sanitized.');process.exit(0);}
if(!values.out)throw Error('Choose an explicit new private --out directory.');
const out=resolve(values.out),work=await mkdtemp(join(tmpdir(),'nnh-discovery-'));
await mkdir(out,{recursive:false,mode:0o700});
const root=resolve(import.meta.dirname,'../../lib/neonethack'),client=new Client({name:'fresh-model-check',version:'1'});
const transcript=[],trace=[],token=randomUUID();let created=0,attempted=0,ended=false,ready,child,timer,server,failed;
const objective='Start one new wizard adventure, read its current scene, inspect the square you stand on, begin a prayer and explicitly decline it, then release the engine while retaining the adventure. Do not take other actions. Stop when the engine has been released. Use only the discovered tools and returned information.';
try{
  await client.connect(new StdioClientTransport({command:join(root,'build/native/neonethack-mcp'),args:[join(root,'engine/playground/nethack'),join(root,'engine/playground'),join(work,'sessions')],stderr:'pipe'}));
  const tools=(await client.listTools()).tools;
  await writeFile(join(out,'discovery.json'),JSON.stringify({tools,instructions:client.getInstructions()}));
  server=createServer(async(req,res)=>{
    const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.headers.authorization!=='Bearer '+token)return reply(403,{error:'Forbidden'});
    if(req.url==='/tools'&&req.method==='GET')return reply(200,{tools});
    try{
      let body='';for await(const part of req){body+=part;if(body.length>65536)throw Error('Request too large');}
      const command=JSON.parse(body);
      if(req.url==='/ready'){
        if(command.tools?.length!==tools.length||command.tools.some(name=>!tools.some(t=>t.name===name)))throw Error('Unexpected model tool set');
        ready=command;return reply(200,{ok:true});
      }
      if(req.url!=='/call'||req.method!=='POST')throw Error('Unknown route');
      if(ended||failed||++attempted>9)throw Error('Exercise stopped or call budget exhausted; not sent.');
      if(!['create','observe','inspect','pray','answer','suspend','help'].includes(command.name))throw Error('Model left the requested exercise.');
      if(command.name==='create'&&++created!==1)throw Error('Model attempted a second creation.');
      if(command.name==='answer'&&command.arguments?.value!==false)throw Error('Model did not explicitly decline the prayer.');
      const response=(await client.callTool(command)).structuredContent;
      if(command.name==='suspend'&&!response.error)ended=true;
      transcript.push({command,response});
      trace.push({tool:command.name,argumentKeys:Object.keys(command.arguments??{}),status:response.outcome?.status,error:response.error?.code,turn:response.observation?.turn,question:response.decision?.kind??null});
      await writeFile(join(out,'private-transcript.json'),JSON.stringify(transcript));
      if(response.error)failed='MCP rejection: '+response.error.code;
      reply(200,{result:response});if(failed)child?.kill('SIGTERM');
    }catch(error){failed??=error.message;reply(409,{error:failed});child?.kill('SIGTERM');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const stdout=openSync(join(out,'pi.jsonl'),'wx'),stderr=openSync(join(out,'pi.stderr.log'),'wx');
  child=spawn('pi',['--model',values.model,'--thinking','low','--no-builtin-tools','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--extension',join(import.meta.dirname,'pi-extension.mjs'),'--session-dir',join(out,'pi-sessions'),'--mode','json','--print','--system-prompt','You are using an unfamiliar game interface. Follow the user task using only the provided tools.\n'+client.getInstructions(),objective],{cwd:work,env:{...process.env,NEOHACK_PI_ENDPOINT:'http://127.0.0.1:'+server.address().port,NEOHACK_PI_TOKEN:token},stdio:['ignore',stdout,stderr]});
  closeSync(stdout);closeSync(stderr);
  timer=setTimeout(()=>{failed??='Two-minute deadline';child.kill('SIGKILL');},120000);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  const names=trace.map(t=>t.tool),passed=!!ready&&!failed&&exit.code===0&&created===1&&ended&&['create','observe','inspect','pray','answer','suspend'].every(t=>names.includes(t));
  await writeFile(join(out,'summary.json'),JSON.stringify({model:values.model,actualModel:ready?.model,provider:ready?.provider,objective,catalogCount:tools.length,catalogBytes:Buffer.byteLength(JSON.stringify(tools)),passed,failed,exit,attempted,trace,limits:'One bounded fresh-model usability sample, not a reliability or gameplay-skill benchmark. No production traffic; no argument repair or tool-name cheat sheet.'},null,2));
  console.log(JSON.stringify({passed,tools:names,summary:join(out,'summary.json')}));if(!passed)process.exitCode=1;
}finally{
  clearTimeout(timer);if(child&&child.exitCode===null)child.kill('SIGKILL');
  server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
  await client.close();await rm(work,{recursive:true,force:true});
}
