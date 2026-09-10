#!/usr/bin/env bun
/**
 * bun examples/pi-webmcp/run.mjs [--minutes 60] [--model vllm/current] [--headed]
 * bun examples/pi-webmcp/run.mjs --check   # read-only WebMCP discovery/help
 * Prerequisites: Bun, Pi configured with a model, agent-browser with Chrome.
 * Config is agent-browser.toml; extension.mjs binds Pi's file tools separately.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);

const NETHACK_DOCS = `# Playing NeoHack through WebMCP

You play NetHack in the actual NeoHack browser game. Aim for ascension: retrieve
and offer the Amulet of Yendor. There are no weakened game rules or hidden-state
privileges. Your tools are the page's named WebMCP operations plus read_file and write_file.
Use read_file/write_file for these instructions, your notes, checkpoints and final report.
No bash, JavaScript-evaluation or general browser-control tool is available.

## Starting and retaining a game
Read the discovered schemas, then deliberately create one character using
create. A dwarven lawful female Valkyrie is a reasonable starting choice.
Record its exact opaque sessionId in PROGRESS.md. Use that ID for every subsequent
operation. Never create a replacement to recover a failed or uncertain request.
The browser profile and Pi session are retained by the launcher. Runtime upgrades
must not silently resume an old game on a different engine. Stop after death or
ascension; save the exact end facts. Do not restart a hero in this invocation.

## Reading the scene
observe gives perceived state and genuine standing decisions for free.
After an error or lost reply, use observe: it checks any retained uncertain receipt
without resending input. If verification fails, stop and follow the resume instruction.
Normal navigation stops need no recovery call. Historical receipt documents are
not current positions or active questions; there is no recover tool.
Consult inspect, lookup, navigation, route and
help when you need their documented information. Use help for exact operation
arguments; the discovered schemas are authoritative. MCP/WebMCP navigation is
higher-level than the precise semantic library; there is no generic act/raw-key
escape hatch. Coordinates and opaque item/creature references are not labels.
Compare location.id after every action: a trap can change levels or branches.
Track HP/maxHP, hunger, conditions, equipment, position, revision and pending
input. Treat terrain, objects, hazards and apparent creatures as separate layers.
Remembered or unseen cells are uncertain. A glyph alone does not identify food
or a monster. Losing sight of a creature does not establish its death.
observation.heard is a rolling buffer. Fresh messages come from action-local
events; corroborate them with the action outcome and current observation.

## Actions, decisions and movement
Every input is a deliberate choice. go/explore/descend have explicit bounds;
use short legs, inspect their actual stop reason and replan after interruption.
A knownWalking route policy is not proof of physical impossibility. Search
plausible dead ends for secret doors instead of repeating refused moves forever.
An action's eligibility means an attempt is offered, not that it will succeed.
Use answer with the exact current decisionId and explicit value matching reply.valueSchema,
or cancel. Do not silently confirm warnings or resume occupations.
Check the returned state after every attack. A dead/moved target is not permission
to attack the same square again. Zero elapsed turns can be legitimate, including
terminal events. Exact end.kind and cause outrank the intended action summary.

## Survival checklist
Verify a useful starting weapon is actually wielded and armor is actually worn.
Use exact current item IDs for wield/equip/eat/throw/read/zap and other actions.
Prioritize a food supply. Act on canonical hunger rather than invented countdowns.
A just-killed corpse is fresh evidence only: species safety remains a separate
question. Never eat old carried meat or unknown corpses based on a glyph or name
assumption. Do not confuse a partly eaten ration with no ration remaining.
Avoid melee floating eyes (paralysis) and gas spores (explosion). Consider a clean
ranged line, with distance and pet positions checked, or another route. Unknown
adjacent creatures are not automatically safe. Do not interpret disappearance
from a tracker as a successful ranged kill. Avoid being surrounded and retreat
before HP becomes critical. Rest only after reassessing nearby threats. Prayer
has costs and is not a guaranteed heal; unidentified wands are uncertain attempts.
Do not weaken rules or blame the engine for tactical mistakes without evidence.

## Evidence and completion
Write PROGRESS.md regularly: exact session, latest turn/level/HP/hunger, pending
decision, carried resources, next plan and uncertainties. Keep notes concise for
compaction. Write a final report with witnessed outcomes and log references,
separating confirmed defects, policy mistakes and hypotheses. The launcher keeps
webmcp.jsonl, browser profile, Pi transcript and Pi session files. A transport
failure can mean input executed: stop and report uncertainty, never retry blindly.
read_file/write_file are real Pi filesystem tools, not a filesystem sandbox; stay in this
run directory. The host handles navigation, tool binding and deadline shutdown.
`;

function journal(config, record) {
  const fd=fs.openSync(path.join(config.runDir,'webmcp.jsonl'),'a',0o600);
  try { fs.writeSync(fd,JSON.stringify({at:new Date().toISOString(),...record})+'\n');fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
async function browser(config, args) {
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('AGENT_BROWSER_'))delete env[key];
  const {stdout}=await execute(config.browserCommand,
    [...(config.headed ? ['--headed','true'] : []),'--config',path.join(config.runDir,'browser.json'),'--session',config.session,
     '--profile',path.join(config.runDir,'browser-profile'),'--json',...args],
    {env,timeout:config.timeoutMs+10000,maxBuffer:16*1024*1024});
  const result=JSON.parse(stdout);
  if(result.success!==true)throw Error(JSON.stringify(result));
  return result;
}
export function pageTools(result, origin) {
  if(!Array.isArray(result.data?.tools))throw Error('WebMCP discovery returned no tool array');
  const tools=result.data.tools.filter(t=>t.origin===origin);
  const names=new Set();
  for(const tool of tools){
    if(typeof tool.name!=='string'||!tool.inputSchema||!tool.frameId||names.has(tool.name)||['read_file','write_file'].includes(tool.name))throw Error('Invalid, duplicate or conflicting WebMCP tool');
    names.add(tool.name);
  }
  if(!names.has('create')||!names.has('observe')||!names.has('help'))throw Error('The configured page does not expose NeoHack WebMCP');
  return tools;
}
async function invoke(config, tool, args) {
  const id=randomUUID(),paramsPath=path.join(config.runDir,`params-${id}.json`);
  fs.writeFileSync(paramsPath,JSON.stringify(args),{flag:'wx',mode:0o600});
  journal(config,{id,type:'request',tool:tool.name,frameId:tool.frameId,arguments:args});
  try{
    const response=await browser(config,['webmcp','invoke',tool.name,'--frame',tool.frameId,'--params','@'+paramsPath,'--timeout',String(config.timeoutMs)]);
    journal(config,{id,type:'response',response});
    if(response.data?.status!=='completed')throw Error('Invocation did not report completed; inspect journal before any further input');
    if(!response.data.output)throw Error("Completed invocation has no output; inspect journal");
    return response.data.output;
  }catch(error){journal(config,{id,type:'uncertain',error:error.message});throw error;}
}

// The explicit extension supplies Pi's own file tools, avoiding game-read collisions.
export default async function(pi, {createReadToolDefinition,createWriteToolDefinition}) {
  const configPath=process.env.NEOHACK_WEBMCP_RUN;
  if(!configPath)throw Error('Use bun examples/pi-webmcp/run.mjs');
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const tools=JSON.parse(fs.readFileSync(path.join(config.runDir,'tools.json'),'utf8'));
  pi.registerTool({...createReadToolDefinition(config.runDir),name:'read_file',label:'Read file'});
  pi.registerTool({...createWriteToolDefinition(config.runDir),name:'write_file',label:'Write file'});
  let busy=false,uncertain=false;
  pi.on('session_start',async(_event,ctx)=>{
    const actual=pi.getActiveTools(), expected=['read_file','write_file',...tools.map(t=>t.name)];
    if(actual.length!==expected.length||actual.some(name=>!expected.includes(name)))throw Error('Unexpected Pi tools; only read_file, write_file and WebMCP are allowed');
    fs.writeFileSync(path.join(config.runDir,'pi-ready.json'),JSON.stringify({tools:actual,model:ctx.model?.id,provider:ctx.model?.provider,contextWindow:ctx.model?.contextWindow},null,2));
  });
  for(const tool of tools){
    pi.registerTool({name:tool.name,label:tool.name,description:tool.description,parameters:tool.inputSchema,
      async execute(_id,args){
        if(uncertain)throw Error('Previous input is uncertain. Stop and record it; automatic retry is disabled.');
        if(Date.now()>=config.deadline)throw Error('Run deadline reached; save your report.');
        if(busy)throw Error('Another WebMCP input is pending; this call was not dispatched.');
        busy=true;
        try{
          const result=await invoke(config,tool,args);
          return {content:[{type:'text',text:JSON.stringify(result)}],details:{source:'page-webmcp'}};
        }catch(error){uncertain=true;throw error;}finally{busy=false;}
      },
    });
  }
}

async function main(){
  const {values}=parseArgs({options:{config:{type:'string',default:path.join(path.dirname(script),'agent-browser.toml')},minutes:{type:'string'},model:{type:'string'},output:{type:'string'},headed:{type:'boolean',default:false},check:{type:'boolean'},'check-pi':{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log('bun examples/pi-webmcp/run.mjs [--minutes 60] [--model vllm/current] [--config FILE.toml] [--output NEW_DIR] [--check] [--check-pi] [--headed]\n--headed forces a visible agent-browser window.\nPi tools: read_file, write_file, and the configured page\'s WebMCP tools. --check only discovers tools and invokes read-only help; it never creates a game or starts Pi. --check-pi tests Pi read_file/write_file + WebMCP help only.');return;}
  const settings=Bun.TOML.parse(fs.readFileSync(values.config,'utf8'));
  const minutes=Number(values.minutes??settings.pi?.minutes),timeoutMs=Number(settings.webmcp?.timeout_ms);
  if(!Number.isFinite(minutes)||minutes<=0||minutes>1440||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300000)throw Error('Invalid duration or timeout in configuration');
  const url=new URL(settings.webmcp.url);
  if(!['http:','https:'].includes(url.protocol))throw Error('WebMCP URL must be HTTP(S)');
  const runDir=values.output?path.resolve(values.output):path.join(os.homedir(),`neohack-webmcp-${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`);
  fs.mkdirSync(runDir,{recursive:false});
  const config={runDir,headed:values.headed,url:url.href,session:'nh-'+randomUUID(),browserCommand:settings.webmcp.command,timeoutMs,deadline:Date.now()+minutes*60000};
  const configPath=path.join(runDir,'run.json');
  fs.writeFileSync(configPath,JSON.stringify(config,null,2));
  fs.writeFileSync(path.join(runDir,'browser.json'),'{}\n');
  fs.writeFileSync(path.join(runDir,'NETHACK.md'),NETHACK_DOCS);
  let child,timer,killTimer;
  const stop=()=>{if(child && child.exitCode===null){child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),3000);}};
  try{
    console.log(`Opening ${url.href}; logs and notes: ${runDir}`);
    await browser(config,['open',url.href]);
    let tools;
    for(let attempt=0;attempt<20;attempt++){
      try{tools=pageTools(await browser(config,['webmcp','list']),url.origin);break;}
      catch(error){if(attempt===19)throw error;await new Promise(resolve=>setTimeout(resolve,500));}
    }
    if(values['check-pi'])tools=tools.filter(t=>t.name==='help');
    fs.writeFileSync(path.join(runDir,'tools.json'),JSON.stringify(tools,null,2));
    if(values.check){
      const result=await invoke(config,tools.find(t=>t.name==='help'),{name:'observe'});
      fs.writeFileSync(path.join(runDir,'check.json'),JSON.stringify(result,null,2));
      if(result?.isError)throw Error('Read-only WebMCP help failed');
      console.log(`Verified ${tools.length} page tools and read-only help. No game created.`);return;
    }
    const prompt=values['check-pi'] ? 'Read NETHACK.md using read_file. Invoke help with name observe. Write check-report.md using write_file, stating what the help returned. Then finish. This is a read-only binding check: do not create a game.' : `Read NETHACK.md, then play one new NeoHack game through the provided WebMCP tools, aiming for ascension. Keep PROGRESS.md current, and write report.md at the end. Continue until terminal state, uncertain execution or deadline ${new Date(config.deadline).toISOString()}. Tools are read_file, write_file and page WebMCP only. Do not merely describe a plan; play.`;
    const fd=fs.openSync(path.join(runDir,'pi.jsonl'),'wx'),err=fs.openSync(path.join(runDir,'pi.stderr.log'),'wx');
    child=spawn(settings.pi.command,['--model',values.model??settings.pi.model,'--thinking',settings.pi.thinking,
      '--no-builtin-tools','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files',
      '--tools',['read_file','write_file',...tools.map(t=>t.name)].join(','),'--extension',path.join(path.dirname(script),'extension.mjs'),
      '--session-dir',path.join(runDir,'pi-sessions'),'--mode','json','--print',
      '--system-prompt',NETHACK_DOCS,prompt],
      {cwd:runDir,env:{...process.env,NEOHACK_WEBMCP_RUN:configPath},stdio:['ignore',fd,err]});
    fs.closeSync(fd);fs.closeSync(err);
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    timer=setTimeout(stop,Math.max(1,config.deadline-Date.now()));
    console.log(`Pi ${values.model??settings.pi.model}: read_file + write_file + ${tools.length} WebMCP tools. Ctrl-C stops the run.`);
    const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
    fs.writeFileSync(path.join(runDir,'exit.json'),JSON.stringify(result,null,2));
    process.exitCode=result.code??0;
  }finally{
    clearTimeout(timer);clearTimeout(killTimer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    try{await browser(config,['close']);}catch(error){console.error('Browser cleanup:',error.message);}
    console.log(`Run files retained: ${runDir}`);
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===script)await main();
