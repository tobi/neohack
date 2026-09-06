import { botLanguage } from './bot-autocomplete';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import './component';
import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import ts from 'typescript';
import { roles } from './characters';
import { loadRuntime, runtimePackage } from './runtime-loader';
import { accountApi, RunRecorder } from './account-client';
import { NeohackWorld } from './component';
import { isSnapshot } from '../../../lib/neonethack/typescript/client';
import { toolMethods } from '../../../lib/neonethack/mcp/tools';
const $ = <T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const output=$('output'), status=$('status');
const log=(message:string)=>{output.textContent=(output.textContent+'\n'+message).slice(-24000);output.scrollTop=output.scrollHeight;};
declare const __IMP_MAIN__: string;
declare const __IMP_STRATEGY__: string;
let files:Record<string,string>={'main.ts':__IMP_MAIN__,'strategy.ts':__IMP_STRATEGY__};
let selected='main.ts', botId:string|undefined, signedIn=false;
const editor:EditorView=new EditorView({doc:files[selected],extensions:[botLanguage(()=>({files:{...files,[selected]:editor.state.doc.toString()},file:selected})),EditorView.updateListener.of(update=>{const head=update.state.selection.main.head,line=update.state.doc.lineAt(head);$('cursor-position').textContent=`Ln ${line.number}, Col ${head-line.from+1}`;}),basicSetup,javascript({typescript:true}),syntaxHighlighting(HighlightStyle.define([{tag:tags.keyword,color:'#d8b0de'},{tag:tags.string,color:'#a9c98a'},{tag:tags.comment,color:'#94a197'},{tag:tags.variableName,color:'#e1dcbf'},{tag:tags.number,color:'#d5b788'},{tag:tags.function(tags.variableName),color:'#9dccca'},{tag:tags.operator,color:'#d1b584'},{tag:tags.typeName,color:'#c6c394'}])),EditorView.theme({'&':{color:'#d6dec5'},'.cm-content':{padding:'16px 0'}}),EditorView.contentAttributes.of({'aria-label':'Bot source code'})],parent:$('editor')});
function storeFile(){files[selected]=editor.state.doc.toString();}
function tabs(){
  $('tabs').replaceChildren();$('file-tree').replaceChildren();
  for(const name of Object.keys(files)){
    const button=document.createElement('button');button.textContent=name;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(name===selected));
    button.onclick=()=>{storeFile();selected=name;editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:files[name]!}});tabs();};
    $('tabs').append(button);
    const entry=document.createElement('button');entry.className='file-entry';entry.textContent=name;entry.setAttribute('aria-current',String(name===selected));entry.onclick=()=>button.click();$('file-tree').append(entry);
  }
}
function freezeProject(value:boolean){
  for(const el of document.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('.project-controls input,.project-controls select,#test,#save,#add-file,#delete-file,#saved-bots')) el.disabled=value;
  $('stop').toggleAttribute('disabled',!value);
}
for(const role of roles){const option=document.createElement('option');option.value=role.id;option.textContent=role.title;$('role').append(option);}
$('add-file').onclick=()=>{
  const name=$<HTMLInputElement>('filename').value.trim();
  if(!/^[\w-]+\.(ts|js)$/.test(name) || Object.hasOwn(files,name) || Object.keys(files).length>=20){status.textContent='Use a new filename ending in .js or .ts (up to 20 files).';return;}
  storeFile();files[name]='';selected=name;editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:''}});tabs();
};
$('delete-file').onclick=()=>{if(selected==='main.ts'){status.textContent='main.ts is the entrypoint and cannot be removed.';return;}delete files[selected];selected='main.ts';editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:files[selected]!}});tabs();};
let saved:any[]=[];
async function refreshBots(){
  try {const user=await accountApi();signedIn=true;$('author').textContent=`Saved privately as ${user.name}`;saved=await accountApi('/bots');}
  catch {signedIn=false;$('author').textContent='Local project · not saved';return;}
  const select=$<HTMLSelectElement>('saved-bots');select.replaceChildren(new Option('Open a saved bot…',''));
  for(const bot of saved) select.add(new Option(bot.name,bot.id));
}
$('saved-bots').onchange=()=>{
  const bot=saved.find(b=>b.id===$<HTMLSelectElement>('saved-bots').value);if(!bot)return;
  files=structuredClone(bot.files);selected='main.ts';botId=bot.id;
  editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:files[selected]!}});
  $<HTMLInputElement>('bot-name').value=bot.name;$<HTMLSelectElement>('role').value=bot.role;$<HTMLSelectElement>('seed-mode').value=bot.seed==='random'?'random':'fixed';$<HTMLInputElement>('seed').value=bot.seed==='random'?'42':bot.seed;seedMode();tabs();
};
$('save').onclick=()=>void (async()=>{
  try {storeFile();const bot=await accountApi('/bots',{id:botId,name:$<HTMLInputElement>('bot-name').value,role:$<HTMLSelectElement>('role').value,seed:$<HTMLSelectElement>('seed-mode').value==='random'?'random':$<HTMLInputElement>('seed').value,files},'PUT');botId=bot.id;status.textContent='Bot saved.';await refreshBots();}
  catch(error){status.textContent=String(error);}
})();
type ActiveRun = {cancelled:boolean;iframe?:HTMLIFrameElement;port?:MessagePort;timer?:ReturnType<typeof setTimeout>;api?:any;recorder?:RunRecorder;inflight?:Promise<void>};
let active: ActiveRun | null = null;
async function stop(reason='Stopped by you.'){
  const run=active;if(!run || run.cancelled)return;run.cancelled=true;
  run.iframe?.remove();run.port?.close();clearTimeout(run.timer);
  status.textContent=reason;log(reason);
  await run.inflight;
  status.textContent=reason;
  await run.api?.close().catch((e:unknown)=>log(String(e)));
  await run.recorder?.flush();
  if(active===run){active=null;freezeProject(false);}
}
$('stop').onclick=()=>void stop();
$('test').onclick=()=>void (async()=>{
  if(active)return;
  storeFile(); const run:ActiveRun={cancelled:false};active=run;freezeProject(true);output.textContent='';
  try {
    const compiled:Record<string,string>=Object.create(null);
    for(const [name,code] of Object.entries(files)){
      const result=ts.transpileModule(code,{fileName:name,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
      const errors=result.diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error) ?? [];
      if(errors.length)throw Error(errors.map(d=>`${name}: ${ts.flattenDiagnosticMessageText(d.messageText,'\n')}`).join('\n'));
      compiled[name]=result.outputText;
    }
    if(!window.isSecureContext || !globalThis.crypto?.subtle) throw Error('Open the workshop over HTTPS or localhost. This address cannot provide the Web Crypto required to verify the game package. No test was started.');
    const roleChoice=$<HTMLSelectElement>('role').value;
    const chosen=roleChoice==='random' ? roles[crypto.getRandomValues(new Uint32Array(1))[0]! % roles.length]! : roles.find(r=>r.id===roleChoice);
    if(!chosen)throw Error('Choose a supported class.');
    const seed=$<HTMLSelectElement>('seed-mode').value==='random' ? crypto.getRandomValues(new Uint32Array(1))[0]! : Number($<HTMLInputElement>('seed').value);
    if(!Number.isSafeInteger(seed)||seed<0||seed>4294967295)throw Error('Seed must be an integer from 0 to 4294967295');
    const budget=1000;
    $('run-identity').textContent=`${chosen.title.replace('The ','')} · Seed ${seed}`;
    status.textContent='Loading the game package…';
    const [{wasm},pkg]=await Promise.all([loadRuntime(),runtimePackage()]);
    if(run.cancelled)return;
    // Test sessions are intentionally volatile. Runtime package identity is retained in the recording.
    const api=await wasm.createWasm({storage:{kind:'memory'},workerUrl:new URL(pkg.base+'core-worker.mjs',location.href)});
    run.api=api;if(run.cancelled){await api.close();return;}
    const game=await api.create({...chosen.identity,name:'Bot test',seed});
    if(run.cancelled){await api.close();return;}
    const world=$('bot-world') as NeohackWorld;world.setAttribute('role',chosen.id);world.setAttribute('seed',String(seed));world.snapshot=game.state;
    if(signedIn)run.recorder=new RunRecorder({name:$<HTMLInputElement>('bot-name').value || 'Untitled bot',role:chosen.id,seed,buildId:pkg.buildId},message=>{$('recording').textContent=message;});
    run.recorder?.record(game.state);
    let calls=0, busy=false, logs=0, halted=false;
    const allowed=new Set([...toolMethods.values()].filter(m=>m.startsWith('game.')||m.startsWith('decision.')||['session.observe','session.actions'].includes(m)));
    const channel=new MessageChannel();run.port=channel.port1;
    channel.port1.onmessage=event=>{
      if(run.cancelled || halted)return;
      const data=event.data;
      if(data.log!==undefined){if(++logs<=500)log(String(data.log).slice(0,2000));return;}
      if(data.done||data.failure){void stop(data.failure?String(data.failure):'Script finished.');return;}
      const request=data.request;
      if(!Number.isSafeInteger(data.id)||!request||request.version!==1||!allowed.has(request.method)||request.params?.sessionId!==game.id||JSON.stringify(request).length>20000){void stop('Rejected a request outside this test session.');return;}
      if(busy){void stop('Concurrent requests are not supported. Await each game operation.');return;}
      if(++calls>budget){void stop(`Test budget reached (${budget} calls).`);return;}
      busy=true;
      run.inflight=(async()=>{
        try{
          const result=await api.transport.send(request);
          if(isSnapshot(result)){world.snapshot=result;run.recorder?.record(result);status.textContent=`${calls}/${budget} calls · Turn ${result.observation.turn} · ${result.observation.location.depthLabel} · Level ${result.observation.vitals.level ?? '?'}`;}
          channel.port1.postMessage({id:data.id,result});
          if(('error' in result && result.error?.code === 'incompleteRequest') || (isSnapshot(result)&&(result.outcome.status==='unknown'||[result.storage,result.recording].some(d=>d&&d.status!=='ok')))) { halted=true;setTimeout(()=>void stop('Execution uncertain or storage failed. No new input was sent.'),0); }
        }catch(error){halted=true;channel.port1.postMessage({id:data.id,error:String(error)});setTimeout(()=>void stop('Transport failed; execution is uncertain. Test stopped.'),0);}
        finally{busy=false;}
      })();
    };
    const iframe=document.createElement('iframe');run.iframe=iframe;iframe.hidden=true;iframe.sandbox.add('allow-scripts');iframe.src='/bots/sandbox.html';
    iframe.onload=()=>{if(!run.cancelled)iframe.contentWindow!.postMessage({type:'neohack-test',payload:{files:compiled,initial:game.state}},'*',[channel.port2]);};
    document.body.append(iframe);
    run.timer=setTimeout(()=>void stop('Five-minute test limit reached.'),300000);
    status.textContent='Test running…';log(`Fresh ${chosen.id}, seed ${seed}. Limit: ${budget} calls / five minutes.`);
  }catch(error){await stop(String(error));}
})();
window.addEventListener('pagehide',()=>{active?.iframe?.remove();active?.port?.close();});
tabs();void refreshBots();

function seedMode(){ $('fixed-seed').hidden=$<HTMLSelectElement>('seed-mode').value==='random'; }
$('seed-mode').onchange=seedMode;
$('clear-output').onclick=()=>{output.textContent='';};
window.addEventListener('accountchange',event=>{signedIn=!!(event as CustomEvent).detail;void refreshBots();});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey) && (event.key==='s'||event.key==='Enter')){event.preventDefault();$<HTMLButtonElement>(event.key==='s'?'save':'test').click();}});
const divider=$('pane-divider'),panes=document.querySelector<HTMLElement>('.ide-panes')!;
function resize(value:number){value=Math.max(30,Math.min(75,value));panes.style.setProperty('--editor-width',value+'%');divider.setAttribute('aria-valuenow',String(Math.round(value)));}
divider.onpointerdown=event=>{divider.setPointerCapture(event.pointerId);};
divider.onpointermove=event=>{if(divider.hasPointerCapture(event.pointerId)){const bounds=panes.getBoundingClientRect();resize((event.clientX-bounds.left)/bounds.width*100);}};
divider.onpointerup=event=>{if(divider.hasPointerCapture(event.pointerId))divider.releasePointerCapture(event.pointerId);};
divider.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();resize(Number(divider.getAttribute('aria-valuenow'))+(event.key==='ArrowRight'?5:-5));}};
if(!window.isSecureContext || !globalThis.crypto?.subtle){
 const notice=$('secure-context');notice.hidden=false;notice.textContent='This HTTP address cannot verify or start a game. Open this workshop over HTTPS, or use localhost on the server’s computer.';
 if(location.protocol==='http:'){const secure=new URL(location.href);secure.protocol='https:';const link=document.createElement('a');link.href=secure.href;link.textContent='Open HTTPS →';notice.append(link);}
}
