import './component';
import { NeohackWorld } from './component';
import { replayLink, embedCode } from './public-replay';
import { validReplayId } from './replay-links';
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const id=location.pathname.split('/')[2]??'';
const viewer=$<NeohackWorld>('replay');
let summary:Record<string,unknown>={}, current:Record<string,unknown>={};
function details(){
  const values=[['Class',summary.role??current.role],['Hero level',summary.heroLevel??current.level],['Peak hero level',summary.maxLevel],['Dungeon location',summary.depthLabel??current.depth],['Deepest dungeon level',summary.maxDepth],['Turns',summary.turn??current.turn],['Outcome',summary.endKind??(summary.ended===false?'Adventuring':current.outcome)],['Last recorded',typeof summary.updatedAt==='number'?new Date(summary.updatedAt).toLocaleString():undefined]];
  $('run-details').replaceChildren(...values.map(([label,value])=>{
    const item=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=String(label);dd.textContent=value===undefined||value===null?'Not recorded':String(value);item.append(dt,dd);return item;
  }));
}
async function copy(id:string,success:string){
  const field=$<HTMLInputElement|HTMLTextAreaElement>(id);
  try{await navigator.clipboard.writeText(field.value);$('copy-status').textContent=success;}
  catch{field.focus();field.select();$('copy-status').textContent='Copy the selected text.';}
}
if(!validReplayId(id)){$('status').textContent='Invalid replay ID.';viewer.hidden=true;$('metadata-status').textContent='No run selected.';}
else {
  $('replay-id').textContent=id;
  $<HTMLInputElement>('share-url').value=replayLink(id);
  $<HTMLTextAreaElement>('embed-code').value=embedCode(id);
  $('copy-link').onclick=()=>void copy('share-url','Replay link copied.');
  $('copy-embed').onclick=()=>void copy('embed-code','Embed code copied.');
  viewer.addEventListener('frame',()=>{
    const s=viewer.snapshot;if(!s)return;
    current={...current,level:s.observation.vitals.level,depth:s.observation.location.depthLabel,turn:s.observation.turn,outcome:s.ended?s.end?.kind:'Adventuring'};details();
  });
  viewer.addEventListener('replaymetadata',event=>{current.role=(event as CustomEvent).detail.role;details();});
  viewer.addEventListener('replayload',event=>{$('status').textContent=`Replay ready · ${(event as CustomEvent).detail.length} recorded ${(event as CustomEvent).detail.format==='neonethack.inputs'?'actions':'frames'}.`;});
  viewer.addEventListener('error',event=>{if(event instanceof CustomEvent)$('status').textContent=String(event.detail);});
  viewer.setAttribute('src',replayLink(id));
  details();
  // Optional public ledger details never gate CDN playback or require sign-in.
  void fetch('/api/runs/'+encodeURIComponent(id),{credentials:'omit',signal:AbortSignal.timeout(10000)})
    .then(async response=>{if(!response.ok)throw Error('Details unavailable');summary=await response.json();
      if(typeof summary.name==='string'){$('replay-title').textContent=summary.name;document.title=summary.name+' · Replay · neohack';}
      $('metadata-status').textContent='Run totals above; the player shows the selected moment.';details();})
    .catch(()=>{$('metadata-status').textContent='Run totals and date are unavailable. Showing details from the selected replay moment.';});
}
